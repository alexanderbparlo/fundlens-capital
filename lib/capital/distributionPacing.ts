import type {
  ConfirmedFields,
  DatedCashFlow,
  PacingConfig,
  WaterfallBreakdown,
} from './scheduleTypes'
import { enumerateQuarterEnds } from './dates'
import {
  splitProceeds,
  preferredReturnOutstanding,
  type WaterfallTerms,
  type PreferredEvent,
} from '@/lib/waterfall/splitProceeds'

const EPSILON = 1e-6

export interface DistributionProjection {
  periods: DatedCashFlow[]   // projected net-of-carry distributions by quarter
  lifetimeLpNet: number      // LP lifetime distributions net of carry (ITD + projected)
  futureLpNet: number        // projected future net-of-carry distributions (the released total)
  breakdown: WaterfallBreakdown
}

// Cumulative preferred-return entitlement on an outstanding-capital basis.
//
// The preferred return accrues on the LP's *unreturned* capital — distributions are
// credited at their actual dates so the hurdle stops accruing on capital already
// returned. When dated history is present we use it directly; otherwise we fall back
// to a synthetic two-event history (all paid-in contributed at vintage, distributions-
// to-date credited at the as-of date). The remaining capital then accrues through fund
// end, the projected final-distribution horizon.
//
// This replaces the prior `paidIn × ((1+r)^(vintage→fundEnd) − 1)` flat accrual, which
// compounded the entire paid-in from vintage to fund end as though all capital were
// contributed at inception — overstating the hurdle so severely that carry could never
// bind even on a genuine profit (the root cause behind the "net of carry but equal to
// gross" report).
function preferredOwed(fields: ConfirmedFields, futureCalledInPlay: number): number {
  const { fundTerms } = fields
  if (!fields.fundEndDate || fundTerms.hurdleRate <= 0) return 0

  const start = fields.vintageDate ?? fields.asOfDate
  const hasHistory =
    fields.historicalCalls.length > 0 || fields.historicalDistributions.length > 0

  const events: PreferredEvent[] = hasHistory
    ? [
        ...fields.historicalCalls.map(c => ({ date: c.date, amount: c.amount })),
        ...fields.historicalDistributions.map(d => ({ date: d.date, amount: -d.amount })),
      ]
    : [
        { date: start, amount: Math.max(0, fields.calledToDate) },
        { date: fields.asOfDate, amount: -Math.max(0, fields.distributionsToDate) },
      ]

  // Future-called capital (when the call multiple is active) is contributed after the
  // as-of date and accrues preferred from there through fund end. Approximated as a
  // single contribution at the as-of date — remaining calls cluster early in the
  // investment period — so it shares the same outstanding-capital accrual as paid-in.
  if (futureCalledInPlay > 0) {
    events.push({ date: fields.asOfDate, amount: futureCalledInPlay })
  }

  return preferredReturnOutstanding(
    events,
    fundTerms.hurdleRate,
    fundTerms.preferredCompounding,
    start,
    fields.fundEndDate
  )
}

// J-curve release shape over the remaining fund life: a smooth asymmetric bell that
// ramps from near zero (early-life trough), peaks around the assumed average exit
// (driven by avgRemainingHold), and tapers to zero as the portfolio winds down at
// fund end. Weights sum to 1.
//
// The peak is held strictly inside the horizon — at least one ramp quarter before and
// one taper quarter after — so for any non-degenerate horizon the largest per-period
// distribution never lands in the final quarter. Real funds wind down toward
// termination; they do not spike a single largest distribution at the very end.
function releaseWeights(count: number, peakIndex: number): number[] {
  if (count <= 0) return []
  if (count === 1) return [1]
  if (count === 2) return [1 / 3, 2 / 3] // too short to both ramp and taper

  // Keep at least one quarter of ramp and one of taper around the peak.
  const peak = Math.min(Math.max(peakIndex, 1), count - 2)

  const raw = Array.from({ length: count }, (_, i) => {
    if (i <= peak) {
      // Raised-cosine ramp: ~0 at the first quarter rising smoothly to 1 at the peak.
      return 0.5 * (1 - Math.cos((Math.PI * (i + 1)) / (peak + 1)))
    }
    // Raised-cosine taper: 1 at the peak falling smoothly to 0 at fund end.
    return 0.5 * (1 + Math.cos((Math.PI * (i - peak)) / (count - 1 - peak)))
  })
  const total = raw.reduce((s, w) => s + w, 0)
  return total > 0 ? raw.map(w => w / total) : raw.map(() => 1 / count)
}

// Projected LP distributions, net of GP carry, across the remaining fund life.
//
// 1. Lifetime gross to the LP = distributions received to date + projected future
//    gross (current NAV × forward value multiple on the remaining holdings).
// 2. Run the lifetime gross through the European waterfall to get lifetime LP-net.
// 3. Future net-of-carry = lifetime LP-net − distributions already received.
// 4. Release that future total across the quarters on the J-curve shape.
export function projectDistributions(
  fields: ConfirmedFields,
  config: PacingConfig
): DistributionProjection {
  // Projected future gross has two terms: current NAV grown by the NAV multiple, plus
  // future-called (unfunded) capital grown by its own, lower multiple. Late-deployed
  // capital has less time to mature, so a single blended multiple would overstate it.
  const navGross = Math.max(0, fields.currentNav) * Math.max(0, config.forwardValueMultiple)
  const callMultiple = Math.max(0, config.forwardCallMultiple ?? 0)
  const futureCalled = Math.max(0, fields.unfundedCommitment)
  const calledGross = futureCalled * callMultiple

  // When the call multiple is active, future-called capital both returns value (added to
  // the base above) AND enters the return-of-capital / preferred basis — otherwise the GP
  // would take carry on the LP's own returned capital. With the multiple off (0) it drops
  // out of the waterfall entirely, reproducing the NAV-only behavior.
  const futureCalledInPlay = callMultiple > 0 ? futureCalled : 0

  const projectedFutureGross = navGross + calledGross
  const lifetimeGross = Math.max(0, fields.distributionsToDate) + projectedFutureGross

  const terms: WaterfallTerms = {
    ...fields.fundTerms,
    paidIn: fields.calledToDate + futureCalledInPlay,
    preferredOwed: preferredOwed(fields, futureCalledInPlay),
  }
  const { lpNet: lifetimeLpNet, breakdown } = splitProceeds(lifetimeGross, terms)

  const futureLpNet = Math.max(0, lifetimeLpNet - Math.max(0, fields.distributionsToDate))

  if (!fields.fundEndDate || futureLpNet <= EPSILON) {
    return { periods: [], lifetimeLpNet, futureLpNet, breakdown }
  }

  const quarters = enumerateQuarterEnds(fields.asOfDate, fields.fundEndDate)
  if (quarters.length === 0) {
    return { periods: [], lifetimeLpNet, futureLpNet, breakdown }
  }

  // Peak position = avg remaining hold expressed in quarters, but capped to ~80% of
  // the horizon so a wind-down taper always remains. Within that band avgRemainingHold
  // moves the peak freely (a longer assumed hold pushes exits later); a hold at or
  // beyond the remaining fund life clamps to the cap rather than peaking at termination.
  const rawPeak = Math.round(Math.max(0, config.avgRemainingHoldYears) * 4)
  const maxPeak = Math.max(1, Math.round((quarters.length - 1) * 0.8))
  const peakIndex = Math.min(rawPeak, maxPeak)
  const weights = releaseWeights(quarters.length, peakIndex)
  const periods = quarters.map((date, i) => ({ date, amount: futureLpNet * weights[i] }))

  return { periods, lifetimeLpNet, futureLpNet, breakdown }
}

export { releaseWeights }
