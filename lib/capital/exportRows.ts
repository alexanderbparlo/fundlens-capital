import type { CapitalSchedule, ConfirmedFields, PacingConfig } from './scheduleTypes'
import { quarterLabel } from './dates'

// Pure export layer: the schedule rows the CSV/XLSX exports display, plus the
// projection-summary block (round 3, Item 4) that makes a Phase-2-style external
// reconciliation possible from the export alone — tiers, entitlement, endpoint, and
// identities, with no repo access. Kept framework-free so the same functions serve
// the ExportButton, the unit tests, and scripted acceptance runs.

export interface DisplayRow {
  quarter: string
  call: number
  distribution: number
  netCashFlow: number
  cumulativeCalled: number
  cumulativeDistributed: number
  cumulativeNet: number
}

export const SCHEDULE_COLUMNS: Array<[keyof DisplayRow, string]> = [
  ['quarter', 'Quarter'],
  ['call', 'Projected Call'],
  // Distributions pass through the whole-fund waterfall — the schedule is LP-net,
  // never gross, so the export says so explicitly.
  ['distribution', 'LP-net Distribution'],
  ['netCashFlow', 'Net Cash Flow'],
  ['cumulativeCalled', 'Cumulative Called'],
  ['cumulativeDistributed', 'Cumulative Distributed'],
  ['cumulativeNet', 'Cumulative Net'],
]

// Largest-remainder allocation to whole dollars (round 3, Item 5): floor every
// value, then hand the leftover dollars to the largest fractional remainders so the
// displayed rows sum to exactly `Math.round(total)`. Display-layer only — the
// underlying schedule keeps full precision. Independent per-row rounding leaked a
// $1 self-inconsistency (calls displayed as $6,999,999 against exact cumulatives).
function allocateWholeDollars(values: number[], total: number): number[] {
  const target = Math.round(total)
  const floors = values.map(v => Math.floor(v))
  let leftover = target - floors.reduce((s, v) => s + v, 0)
  const order = values
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i)
  const out = [...floors]
  for (let k = 0; leftover > 0 && k < order.length; k++, leftover--) out[order[k].i] += 1
  // A negative leftover can only arise from a pathological total; take it back from
  // the smallest remainders.
  for (let k = order.length - 1; leftover < 0 && k >= 0; k--, leftover++) out[order[k].i] -= 1
  return out
}

// Display rows with self-consistent whole-dollar arithmetic: every cumulative cell is
// recomputable from the displayed per-period rows with zero drift.
export function buildDisplayRows(schedule: CapitalSchedule): DisplayRow[] {
  const calls = allocateWholeDollars(
    schedule.periods.map(p => p.call),
    schedule.periods.reduce((s, p) => s + p.call, 0)
  )
  const dists = allocateWholeDollars(
    schedule.periods.map(p => p.distribution),
    schedule.periods.reduce((s, p) => s + p.distribution, 0)
  )

  const openingCalled = Math.round(schedule.openingCumulativeCalled)
  const openingDistributed = Math.round(schedule.openingCumulativeDistributed)

  let cumulativeCalled = openingCalled
  let cumulativeDistributed = openingDistributed
  let cumulativeNet = openingDistributed - openingCalled

  return schedule.periods.map((p, i) => {
    const netCashFlow = dists[i] - calls[i]
    cumulativeCalled += calls[i]
    cumulativeDistributed += dists[i]
    cumulativeNet += netCashFlow
    return {
      quarter: p.label,
      call: calls[i],
      distribution: dists[i],
      netCashFlow,
      cumulativeCalled,
      cumulativeDistributed,
      cumulativeNet,
    }
  })
}

const money = (v: number) => v.toFixed(2)

// The labeled summary block appended after the schedule rows (Item 4): engine
// version, run parameters, accrual endpoint, preferred entitlement, and the full
// tier breakdown. Values are penny-precision engine output, NOT display-rounded —
// the external validator reconciles these against its own recomputation.
export function buildSummaryRows(
  schedule: CapitalSchedule,
  fields: ConfirmedFields,
  config: PacingConfig
): Array<[string, string]> {
  const b = schedule.distributionBreakdown
  const gpCarry = b.gpCatchUp + b.gpProfitSplit
  const callMultiple = Math.max(0, config.forwardCallMultiple ?? 0)
  const futureGross =
    Math.max(0, fields.currentNav) * Math.max(0, config.forwardValueMultiple) +
    Math.max(0, fields.unfundedCommitment) * callMultiple
  const lifetimeGross = Math.max(0, fields.distributionsToDate) + futureGross

  return [
    ['Engine Version', schedule.engineVersion],
    ['As-Of Date', schedule.asOfDate],
    ['Accrual Endpoint (= final grid date)', schedule.accrualEndDate ?? '—'],
    ['Call Pacing Mode', config.callCurve],
    ['Call Decay (front-loaded)', String(config.callDecay)],
    ['Forward Value Multiple (NAV)', String(config.forwardValueMultiple)],
    ['Forward Call Multiple', String(callMultiple)],
    ['Avg Remaining Hold (years)', String(config.avgRemainingHoldYears)],
    ['Hold Capped by Fund Life', schedule.holdCapped ? 'yes' : 'no'],
    ['Effective Peak Quarter', schedule.effectivePeakDate ? quarterLabel(schedule.effectivePeakDate) : '—'],
    ['Called to Date', money(fields.calledToDate)],
    ['Unfunded Commitment', money(fields.unfundedCommitment)],
    ['Distributions to Date', money(fields.distributionsToDate)],
    ['Current NAV', money(fields.currentNav)],
    ['Projected Future Gross', money(futureGross)],
    ['Lifetime Gross', money(lifetimeGross)],
    ['Preferred Entitlement', money(schedule.preferredEntitlement)],
    ['Tier 1 — Return of Capital', money(b.returnOfCapital)],
    ['Tier 2 — Preferred Return', money(b.preferredReturn)],
    ['Tier 3 — GP Catch-Up', money(b.gpCatchUp)],
    ['Tier 4 — LP Residual Split', money(b.lpProfitSplit)],
    ['Tier 4 — GP Residual Split', money(b.gpProfitSplit)],
    ['GP Carry Total', money(gpCarry)],
    ['Lifetime LP-Net', money(schedule.lifetimeLpNet)],
    ['Future LP-Net (schedule total)', money(schedule.futureLpNet)],
    ['Total Projected Calls', money(schedule.totalProjectedCalls)],
  ]
}

const csvCell = (v: string | number): string => {
  const s = String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function buildCsv(
  schedule: CapitalSchedule,
  fields: ConfirmedFields,
  config: PacingConfig
): string {
  const rows = buildDisplayRows(schedule)
  const header = SCHEDULE_COLUMNS.map(c => c[1]).join(',')
  const body = rows
    .map(r => SCHEDULE_COLUMNS.map(([key]) => csvCell(r[key])).join(','))
    .join('\n')
  const summary = buildSummaryRows(schedule, fields, config)
    .map(([label, value]) => `${csvCell(label)},${csvCell(value)}`)
    .join('\n')
  return `${header}\n${body}\n\nProjection Summary,Value\n${summary}\n`
}
