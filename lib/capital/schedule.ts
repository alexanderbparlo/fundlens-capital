import type {
  CapitalSchedule,
  ConfirmedFields,
  PacingConfig,
  ProjectedPeriod,
} from './scheduleTypes'
import { enumerateQuarterEnds, quarterLabel } from './dates'
import { projectCalls } from './callPacing'
import { projectDistributions } from './distributionPacing'

// Bump when the projection math changes — persisted alongside each run snapshot so
// projections can be diffed across builds (handoff §11).
// 1.1.0 — remediation round 1: outstanding-capital preferred accrual (carry now binds),
//   raised-cosine peak-and-taper distribution curve, forward multiple on called capital,
//   forward-only peak funding need.
export const ENGINE_VERSION = '1.1.0'

const EPSILON = 1e-6

// Orchestrates the two independent projection tracks into one dated grid, applies
// per-period overrides, and accumulates running positions opening from ITD actuals.
export function buildSchedule(fields: ConfirmedFields, config: PacingConfig): CapitalSchedule {
  const callSeries = projectCalls(fields, config)
  const distribution = projectDistributions(fields, config)

  const callByDate = new Map(callSeries.map(c => [c.date, c.amount]))
  const distByDate = new Map(distribution.periods.map(d => [d.date, d.amount]))
  const overrideByDate = new Map(config.overrides.map(o => [o.date, o]))

  // Grid horizon spans both tracks: calls end at IP end, distributions at fund end.
  const horizonEnd = [fields.investmentPeriodEndDate, fields.fundEndDate]
    .filter((d): d is string => Boolean(d))
    .sort()
    .at(-1)

  const gridDates = horizonEnd ? enumerateQuarterEnds(fields.asOfDate, horizonEnd) : []

  const openingCalled = fields.calledToDate
  const openingDistributed = fields.distributionsToDate
  const openingNet = openingDistributed - openingCalled

  let cumulativeCalled = openingCalled
  let cumulativeDistributed = openingDistributed
  let cumulativeNet = openingNet

  const periods: ProjectedPeriod[] = gridDates.map(date => {
    const override = overrideByDate.get(date)

    const callOverridden = override?.call !== undefined && override.call !== null
    const distributionOverridden = override?.distribution !== undefined && override.distribution !== null

    const call = callOverridden ? (override!.call as number) : callByDate.get(date) ?? 0
    const distribution_ = distributionOverridden
      ? (override!.distribution as number)
      : distByDate.get(date) ?? 0

    const netCashFlow = distribution_ - call

    cumulativeCalled += call
    cumulativeDistributed += distribution_
    cumulativeNet += netCashFlow

    return {
      date,
      label: quarterLabel(date),
      call,
      distribution: distribution_,
      netCashFlow,
      cumulativeCalled,
      cumulativeDistributed,
      cumulativeNet,
      callOverridden,
      distributionOverridden,
    }
  })

  const totalProjectedCalls = periods.reduce((s, p) => s + p.call, 0)
  const totalProjectedDistributions = periods.reduce((s, p) => s + p.distribution, 0)

  // Trough = deepest LIFETIME cumulative net position (opens at the already-funded
  // position). The opening position itself can be the deepest point if the LP is already
  // net-negative and distributions outpace calls from the first quarter. This drives the
  // J-curve trough marker — it is NOT the forward funding need. The marquee "peak funding
  // need" is computed from a forward-only series in buildLiquidityView; the two read off
  // different series by design (peak funding need = forward; crossover = lifetime).
  let trough: { date: string; value: number } = { date: fields.asOfDate, value: openingNet }
  for (const p of periods) {
    if (p.cumulativeNet < trough.value) trough = { date: p.date, value: p.cumulativeNet }
  }

  // Crossover = first quarter the LP turns net-positive on the LIFETIME series — the
  // legitimate DPI = 1.0 "got my money back" breakeven. Stays on lifetime cumulative net
  // (do not move it to the forward series that peak funding need uses).
  const crossPeriod = periods.find(p => p.cumulativeNet >= -EPSILON)
  const crossover = crossPeriod ? { date: crossPeriod.date } : null

  return {
    asOfDate: fields.asOfDate,
    engineVersion: ENGINE_VERSION,
    periods,
    openingCumulativeCalled: openingCalled,
    openingCumulativeDistributed: openingDistributed,
    openingCumulativeNet: openingNet,
    totalProjectedCalls,
    totalProjectedDistributions,
    trough,
    crossover,
    lifetimeLpNet: distribution.lifetimeLpNet,
    futureLpNet: distribution.futureLpNet,
    distributionBreakdown: distribution.breakdown,
  }
}
