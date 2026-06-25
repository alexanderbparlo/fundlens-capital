import type {
  ConfirmedFields,
  DatedCashFlow,
  PacingConfig,
  WaterfallBreakdown,
} from './scheduleTypes'
import { enumerateQuarterEnds, yearsBetween } from './dates'
import { splitProceeds, type WaterfallTerms } from '@/lib/waterfall/splitProceeds'

const EPSILON = 1e-6

export interface DistributionProjection {
  periods: DatedCashFlow[]   // projected net-of-carry distributions by quarter
  lifetimeLpNet: number      // LP lifetime distributions net of carry (ITD + projected)
  futureLpNet: number        // projected future net-of-carry distributions (the released total)
  breakdown: WaterfallBreakdown
}

// Number of years over which the LP's preferred return accrues: vintage → fund end
// (the whole-fund horizon). Falls back to as-of → fund end when vintage is unknown.
function preferredAccrualYears(fields: ConfirmedFields): number {
  if (!fields.fundEndDate) return 0
  const start = fields.vintageDate ?? fields.asOfDate
  return Math.max(0, yearsBetween(start, fields.fundEndDate))
}

// J-curve release shape over the remaining fund life: an asymmetric triangle that
// ramps from near zero (early-life trough), peaks around the assumed average exit,
// and tapers to zero at fund end. Weights sum to 1.
function releaseWeights(count: number, peakIndex: number): number[] {
  if (count <= 0) return []
  if (count === 1) return [1]
  const peak = Math.min(Math.max(peakIndex, 0), count - 1)
  const raw = Array.from({ length: count }, (_, i) => {
    if (i <= peak) return (i + 1) / (peak + 1)          // ramp up to the peak
    return Math.max(0, (count - 1 - i) / (count - 1 - peak)) // taper to fund end
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
  const projectedFutureGross = Math.max(0, fields.currentNav) * Math.max(0, config.forwardValueMultiple)
  const lifetimeGross = Math.max(0, fields.distributionsToDate) + projectedFutureGross

  const terms: WaterfallTerms = {
    ...fields.fundTerms,
    paidIn: fields.calledToDate,
    prefYears: preferredAccrualYears(fields),
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

  const peakIndex = Math.round(Math.max(0, config.avgRemainingHoldYears) * 4)
  const weights = releaseWeights(quarters.length, peakIndex)
  const periods = quarters.map((date, i) => ({ date, amount: futureLpNet * weights[i] }))

  return { periods, lifetimeLpNet, futureLpNet, breakdown }
}

export { releaseWeights }
