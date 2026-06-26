import type { FundTerms, WaterfallResult } from '@/lib/capital/scheduleTypes'
import { yearsBetween } from '@/lib/capital/dates'

// Inputs for the LP-level waterfall split. This is a clean reimplementation of the
// DesoFall tier semantics (ROC → preferred → GP catch-up → carry split), modeled as
// a whole-fund (European) waterfall applied to a single LP's own cash flows.
//
// It is applied CUMULATIVELY over the LP's fund life: `grossProceeds` is the LP's
// total lifetime gross (distributions received to date + projected future gross),
// and `paidIn` is the LP's contributed capital. The caller subtracts distributions
// already received to obtain the net-of-carry FUTURE distributions. Carry therefore
// only bites once the LP has been made whole on capital + preferred across the whole
// fund — the defining property of a European waterfall.
export interface WaterfallTerms extends FundTerms {
  paidIn: number        // LP contributed capital (the return-of-capital basis)
  preferredOwed: number // cumulative preferred-return entitlement (see preferredReturnOutstanding)
}

// A dated capital event for the preferred-return accrual.
// amount > 0 = contribution (capital called); amount < 0 = distribution (credited).
export interface PreferredEvent {
  date: string
  amount: number
}

// Cumulative preferred-return entitlement on an OUTSTANDING-CAPITAL basis.
//
// The preferred return accrues on the LP's *unreturned* capital, not on a flat
// lump of total paid-in. We walk the dated contribution/distribution history,
// compounding (or simple-accruing) the hurdle between events, and crediting each
// distribution against the outstanding balance so it stops accruing preferred on
// capital that has already been returned. The remaining capital then continues to
// accrue through `endDate` (the projected final distribution at fund end).
//
// This corrects the prior over-accrual that compounded the *entire* paid-in from
// vintage to fund end as though all capital were contributed at inception — which
// inflated the hurdle so far that carry could never bind even on a real profit.
//
//   compound: the hurdle compounds on (unreturned capital + unpaid preferred);
//             distributions pay down accrued preferred first, then capital.
//   simple:   the hurdle accrues linearly on unreturned capital only;
//             distributions return capital.
export function preferredReturnOutstanding(
  events: PreferredEvent[],
  hurdleRate: number,
  compounding: FundTerms['preferredCompounding'],
  startDate: string,
  endDate: string
): number {
  if (hurdleRate <= 0) return 0

  const ordered = [...events]
    .filter(e => Number.isFinite(e.amount) && e.amount !== 0 && Boolean(e.date))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))

  let capital = 0   // unreturned contributed capital
  let accrued = 0   // accrued, unpaid preferred return
  let last = startDate

  const grow = (base: number, dt: number): number =>
    compounding === 'compound'
      ? base * (Math.pow(1 + hurdleRate, dt) - 1)
      : base * hurdleRate * dt

  for (const e of ordered) {
    const dt = Math.max(0, yearsBetween(last, e.date))
    accrued += grow(compounding === 'compound' ? capital + accrued : capital, dt)

    if (e.amount > 0) {
      capital += e.amount // contribution
    } else {
      let credit = -e.amount // distribution magnitude
      if (compounding === 'compound') {
        const payPref = Math.min(accrued, credit)
        accrued -= payPref
        credit -= payPref
      }
      capital = Math.max(0, capital - credit)
    }
    last = e.date
  }

  const tail = Math.max(0, yearsBetween(last, endDate))
  accrued += grow(compounding === 'compound' ? capital + accrued : capital, tail)

  return Math.max(0, accrued)
}

export function splitProceeds(grossProceeds: number, terms: WaterfallTerms): WaterfallResult {
  const breakdown = {
    returnOfCapital: 0,
    preferredReturn: 0,
    gpCatchUp: 0,
    lpProfitSplit: 0,
    gpProfitSplit: 0,
  }

  let remaining = Math.max(0, grossProceeds)

  // Tier 1 — Return of capital (to the LP).
  breakdown.returnOfCapital = Math.min(remaining, Math.max(0, terms.paidIn))
  remaining -= breakdown.returnOfCapital

  // Tier 2 — Preferred return (to the LP). Precomputed on an outstanding-capital basis.
  const pref = Math.max(0, terms.preferredOwed)
  breakdown.preferredReturn = Math.min(remaining, pref)
  remaining -= breakdown.preferredReturn

  // Tier 3 — GP catch-up (100%). The GP receives until its profit share equals the
  // carry fraction of profit distributed so far. With the LP holding `pref` of profit,
  // the self-consistent target is pref * carry / (1 - carry); after the residual splits
  // at the carry rate, the GP ends with exactly carry% of total profit above ROC.
  const carry = terms.carryRate
  if (terms.catchUp === 'full' && remaining > 0 && carry > 0 && carry < 1) {
    const catchUpTarget = breakdown.preferredReturn * (carry / (1 - carry))
    breakdown.gpCatchUp = Math.min(remaining, catchUpTarget)
    remaining -= breakdown.gpCatchUp
  }

  // Tier 4 — Carried-interest split of the residual.
  if (remaining > 0 && carry > 0 && carry < 1) {
    breakdown.lpProfitSplit = remaining * (1 - carry)
    breakdown.gpProfitSplit = remaining * carry
    remaining = 0
  } else if (remaining > 0) {
    // No carry (carry 0) — residual all to the LP.
    breakdown.lpProfitSplit = remaining
    remaining = 0
  }

  const lpNet = breakdown.returnOfCapital + breakdown.preferredReturn + breakdown.lpProfitSplit
  const gpCarry = breakdown.gpCatchUp + breakdown.gpProfitSplit

  return { lpNet, gpCarry, breakdown }
}
