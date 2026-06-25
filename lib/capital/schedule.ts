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
export const ENGINE_VERSION = '1.0.0'

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

  // Trough = deepest cumulative net position. The opening position itself can be
  // the deepest point if the LP is already net-negative and distributions outpace
  // calls from the first quarter.
  let trough: { date: string; value: number } = { date: fields.asOfDate, value: openingNet }
  for (const p of periods) {
    if (p.cumulativeNet < trough.value) trough = { date: p.date, value: p.cumulativeNet }
  }

  // Crossover = first quarter the LP turns net-positive.
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
