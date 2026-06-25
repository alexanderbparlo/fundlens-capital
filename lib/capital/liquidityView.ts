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

  // Peak funding need = the deepest cumulative net position, expressed as a positive
  // liquidity figure. This is the most the LP is ever "in the hole" net of returns.
  const peakFundingNeed =
    schedule.trough && schedule.trough.value < 0
      ? { date: schedule.trough.date, value: -schedule.trough.value }
      : null

  return { openingUnfunded, periods, rollingLiquidityRequired, peakFundingNeed }
}
