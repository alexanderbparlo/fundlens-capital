import type { ConfirmedFields, DatedCashFlow, PacingConfig } from './scheduleTypes'
import { enumerateQuarterEnds, distinctQuarterCount } from './dates'

const EPSILON = 1e-6

// Front-loaded default: distribute remaining unfunded across the quarters to
// investment-period end using geometrically declining weights. Early quarters
// take the largest draws and the series tapers — the typical deployment shape.
function frontLoaded(unfunded: number, quarters: string[], decay: number): DatedCashFlow[] {
  const d = decay > 0 && decay <= 1 ? decay : 0.7
  const weights = quarters.map((_, i) => Math.pow(d, i))
  const total = weights.reduce((s, w) => s + w, 0)
  return quarters.map((date, i) => ({ date, amount: (unfunded * weights[i]) / total }))
}

// History-fit: project forward at the observed historical deployment pace (average
// called per quarter), capped so the cumulative never exceeds the remaining unfunded.
// Any residual still uncalled at IP end is placed in the final quarter, so the full
// unfunded commitment is deployed within the investment period.
function historyFit(
  unfunded: number,
  quarters: string[],
  history: DatedCashFlow[]
): DatedCashFlow[] {
  const totalHistorical = history.reduce((s, c) => s + c.amount, 0)
  const histQuarters = distinctQuarterCount(history.map(c => c.date))
  if (totalHistorical <= 0 || histQuarters === 0) {
    return frontLoaded(unfunded, quarters, 0.7) // no usable history — fall back
  }

  const avgPerQuarter = totalHistorical / histQuarters
  const calls: DatedCashFlow[] = []
  let remaining = unfunded
  for (const date of quarters) {
    const amount = Math.min(avgPerQuarter, remaining)
    calls.push({ date, amount })
    remaining -= amount
  }
  // Place any residual into the last quarter — unfunded must be called within the IP.
  if (remaining > EPSILON && calls.length > 0) {
    calls[calls.length - 1].amount += remaining
  }
  return calls
}

// Projected capital calls from as-of date through investment-period end.
// Returns [] when there is no callable capital or no forward investment period.
export function projectCalls(fields: ConfirmedFields, config: PacingConfig): DatedCashFlow[] {
  const unfunded = fields.unfundedCommitment
  if (!fields.investmentPeriodEndDate || unfunded <= EPSILON) return []

  const quarters = enumerateQuarterEnds(fields.asOfDate, fields.investmentPeriodEndDate)
  if (quarters.length === 0) return []

  return config.callCurve === 'history-fit'
    ? historyFit(unfunded, quarters, fields.historicalCalls)
    : frontLoaded(unfunded, quarters, config.callDecay)
}
