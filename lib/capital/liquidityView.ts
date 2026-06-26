import type {
  CapitalSchedule,
  ConfirmedFields,
  LiquidityPeriod,
  LiquidityView,
  RollingLiquidity,
} from './scheduleTypes'

// Rolling windows surfaced as "liquidity required over the next N quarters" — the
// practical dry-powder answer. 4 / 8 / 12 quarters ≈ 1 / 2 / 3 years.
const ROLLING_WINDOWS = [4, 8, 12]

// Reframes the projected schedule as a dated treasury obligation: per quarter, the
// liquidity needed (call), the unfunded balance drawn down, the liquidity returned
// (distribution), and the net position. This is the LP-specific view neither
// Forecast nor the Waterfall calculator produces.
export function buildLiquidityView(
  schedule: CapitalSchedule,
  fields: ConfirmedFields
): LiquidityView {
  const openingUnfunded = Math.max(0, fields.unfundedCommitment)

  let runningUnfunded = openingUnfunded
  const periods: LiquidityPeriod[] = schedule.periods.map(p => {
    runningUnfunded = Math.max(0, runningUnfunded - p.call)
    return {
      date: p.date,
      label: p.label,
      call: p.call,
      runningUnfunded,
      distribution: p.distribution,
      netLiquidity: p.distribution - p.call,
    }
  })

  const rollingLiquidityRequired: RollingLiquidity[] = ROLLING_WINDOWS.map(quarters => ({
    quarters,
    amount: periods.slice(0, quarters).reduce((sum, p) => sum + p.call, 0),
  }))

  // Peak funding need = the deepest point of the FORWARD-ONLY cumulative-net series,
  // which resets to 0 at the as-of date and sums only projected flows (distribution −
  // call) from the first forward quarter onward. Prior calls are treated as done.
  //
  // This is deliberately NOT the lifetime trough (schedule.trough), which opens at the
  // already-funded, sunk position (distributions-to-date − called-to-date) and so bundles
  // capital that is already deployed into a number framed as forward treasury planning.
  // An LP CFO asking "how much dry powder do I keep on hand?" needs the forward figure.
  // It is bounded by remaining unfunded (calls sum to at most the unfunded commitment)
  // less any distributions arriving before the trough.
  //
  // The J-curve CROSSOVER intentionally stays on the LIFETIME series (see schedule.ts):
  // crossing zero on lifetime cumulative net is the legitimate DPI = 1.0 breakeven. After
  // this split the two headline metrics read off different series by design — do not
  // "correct" one to match the other.
  let forwardCum = 0
  let forwardTrough = { date: schedule.asOfDate, value: 0 }
  for (const p of schedule.periods) {
    forwardCum += p.netCashFlow
    if (forwardCum < forwardTrough.value) forwardTrough = { date: p.date, value: forwardCum }
  }
  const peakFundingNeed =
    forwardTrough.value < 0 ? { date: forwardTrough.date, value: -forwardTrough.value } : null

  return { openingUnfunded, periods, rollingLiquidityRequired, peakFundingNeed }
}
