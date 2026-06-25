import type { FundTerms, WaterfallResult } from '@/lib/capital/scheduleTypes'

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
  paidIn: number    // LP contributed capital (the return-of-capital basis)
  prefYears: number // years over which the preferred return accrues
}

// Cumulative preferred return owed on the LP's paid-in capital.
function preferredReturnAmount(terms: WaterfallTerms): number {
  const { paidIn, hurdleRate, prefYears, preferredCompounding } = terms
  if (paidIn <= 0 || prefYears <= 0 || hurdleRate <= 0) return 0
  return preferredCompounding === 'compound'
    ? paidIn * (Math.pow(1 + hurdleRate, prefYears) - 1)
    : paidIn * hurdleRate * prefYears
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

  // Tier 2 — Preferred return (to the LP).
  const pref = preferredReturnAmount(terms)
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

export { preferredReturnAmount }
