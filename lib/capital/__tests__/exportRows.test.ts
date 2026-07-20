import { describe, it, expect } from 'vitest'
import type { ConfirmedFields, PacingConfig } from '../scheduleTypes'
import { buildSchedule } from '../schedule'
import { buildDisplayRows, buildSummaryRows, buildCsv } from '../exportRows'

// Round 3, Items 4 + 5 — the export must be self-sufficient for an external
// Phase-2-style reconciliation (summary block, penny precision) and internally
// consistent at whole-dollar display precision (largest-remainder allocation).

const WESTBROOK_R2: ConfirmedFields = {
  fundName: 'Westbrook Capital Partners IV, L.P.',
  currency: 'USD',
  asOfDate: '2026-03-31',
  vintageDate: '2021-06-01',
  investmentPeriodEndDate: '2028-06-01',
  fundEndDate: '2031-06-01',
  commitment: 25_000_000,
  calledToDate: 18_000_000,
  unfundedCommitment: 7_000_000,
  distributionsToDate: 4_200_000,
  currentNav: 19_500_000,
  fundTerms: { hurdleRate: 0.08, carryRate: 0.2, catchUp: 'full', preferredCompounding: 'compound' },
  historicalCalls: [
    { date: '2021-09-30', amount: 3_750_000 },
    { date: '2021-12-31', amount: 2_500_000 },
    { date: '2022-03-31', amount: 2_000_000 },
    { date: '2022-09-30', amount: 2_250_000 },
    { date: '2023-09-30', amount: 1_750_000 },
    { date: '2024-03-31', amount: 1_500_000 },
    { date: '2024-09-30', amount: 1_250_000 },
    { date: '2025-03-31', amount: 1_000_000 },
    { date: '2025-09-30', amount: 750_000 },
    { date: '2025-12-31', amount: 500_000 },
    { date: '2026-03-31', amount: 750_000 },
  ],
  historicalDistributions: [
    { date: '2023-12-31', amount: 400_000 },
    { date: '2024-06-30', amount: 600_000 },
    { date: '2024-12-31', amount: 700_000 },
    { date: '2025-06-30', amount: 800_000 },
    { date: '2025-09-30', amount: 700_000 },
    { date: '2025-12-31', amount: 500_000 },
    { date: '2026-03-31', amount: 500_000 },
  ],
}

const CONFIG_FL: PacingConfig = {
  callCurve: 'front-loaded',
  callDecay: 0.7,
  forwardValueMultiple: 1.6,
  forwardCallMultiple: 1.4,
  avgRemainingHoldYears: 4,
  overrides: [],
}
const CONFIG_HF: PacingConfig = { ...CONFIG_FL, callCurve: 'history-fit' }

const MODES: Array<[string, PacingConfig]> = [
  ['front-loaded', CONFIG_FL],
  ['history-fit', CONFIG_HF],
]

describe('Item 5 — largest-remainder display rounding', () => {
  for (const [mode, config] of MODES) {
    const schedule = buildSchedule(WESTBROOK_R2, config)
    const rows = buildDisplayRows(schedule)

    it(`${mode}: displayed calls sum to exactly the unfunded commitment`, () => {
      // The engine deploys exactly $7M at full precision; the displayed whole-dollar
      // rows must reproduce it exactly — not $6,999,999.
      const total = rows.reduce((s, r) => s + r.call, 0)
      expect(total).toBe(7_000_000)
      expect(Number.isInteger(total)).toBe(true)
    })

    it(`${mode}: displayed distributions sum to the rounded schedule total`, () => {
      const total = rows.reduce((s, r) => s + r.distribution, 0)
      expect(total).toBe(Math.round(schedule.totalProjectedDistributions))
    })

    it(`${mode}: every displayed cumulative cell is recomputable from displayed rows with zero drift`, () => {
      let cumCalled = Math.round(schedule.openingCumulativeCalled)
      let cumDist = Math.round(schedule.openingCumulativeDistributed)
      let cumNet = cumDist - cumCalled
      for (const r of rows) {
        expect(r.netCashFlow).toBe(r.distribution - r.call)
        cumCalled += r.call
        cumDist += r.distribution
        cumNet += r.netCashFlow
        expect(r.cumulativeCalled).toBe(cumCalled)
        expect(r.cumulativeDistributed).toBe(cumDist)
        expect(r.cumulativeNet).toBe(cumNet)
      }
    })

    it(`${mode}: displayed rows stay within $1 of the full-precision schedule`, () => {
      schedule.periods.forEach((p, i) => {
        expect(Math.abs(rows[i].call - p.call)).toBeLessThan(1)
        expect(Math.abs(rows[i].distribution - p.distribution)).toBeLessThan(1)
      })
    })
  }
})

describe('Item 4 — projection summary block (Phase-2 reconciliation without repo access)', () => {
  for (const [mode, config] of MODES) {
    const schedule = buildSchedule(WESTBROOK_R2, config)
    const summary = new Map(buildSummaryRows(schedule, WESTBROOK_R2, config))
    const num = (label: string) => Number(summary.get(label))

    it(`${mode}: summary values match engine output to the penny`, () => {
      const b = schedule.distributionBreakdown
      expect(num('Preferred Entitlement')).toBeCloseTo(schedule.preferredEntitlement, 2)
      expect(num('Tier 1 — Return of Capital')).toBeCloseTo(b.returnOfCapital, 2)
      expect(num('Tier 2 — Preferred Return')).toBeCloseTo(b.preferredReturn, 2)
      expect(num('Tier 3 — GP Catch-Up')).toBeCloseTo(b.gpCatchUp, 2)
      expect(num('Tier 4 — LP Residual Split')).toBeCloseTo(b.lpProfitSplit, 2)
      expect(num('Tier 4 — GP Residual Split')).toBeCloseTo(b.gpProfitSplit, 2)
      expect(num('GP Carry Total')).toBeCloseTo(b.gpCatchUp + b.gpProfitSplit, 2)
      expect(num('Lifetime LP-Net')).toBeCloseTo(schedule.lifetimeLpNet, 2)
      expect(num('Future LP-Net (schedule total)')).toBeCloseTo(schedule.futureLpNet, 2)
      expect(summary.get('Engine Version')).toBe(schedule.engineVersion)
      expect(summary.get('Accrual Endpoint (= final grid date)')).toBe('2031-06-30')
      expect(summary.get('Call Pacing Mode')).toBe(config.callCurve)
    })

    it(`${mode}: the identities close from summary values alone`, () => {
      // An external validator holding ONLY the export can verify:
      //   tiers sum to lifetime gross,
      //   lifetime LP-net + GP carry = lifetime gross,
      //   future LP-net = lifetime LP-net − distributions to date,
      //   lifetime gross = distributions to date + NAV×navMult + unfunded×callMult.
      const tierSum =
        num('Tier 1 — Return of Capital') +
        num('Tier 2 — Preferred Return') +
        num('Tier 3 — GP Catch-Up') +
        num('Tier 4 — LP Residual Split') +
        num('Tier 4 — GP Residual Split')
      expect(tierSum).toBeCloseTo(num('Lifetime Gross'), 1)
      expect(num('Lifetime LP-Net') + num('GP Carry Total')).toBeCloseTo(num('Lifetime Gross'), 1)
      expect(num('Future LP-Net (schedule total)')).toBeCloseTo(
        num('Lifetime LP-Net') - num('Distributions to Date'), 1
      )
      const recomputedGross =
        num('Distributions to Date') +
        num('Current NAV') * Number(summary.get('Forward Value Multiple (NAV)')) +
        num('Unfunded Commitment') * Number(summary.get('Forward Call Multiple'))
      expect(recomputedGross).toBeCloseTo(num('Lifetime Gross'), 1)
    })
  }

  it('CSV carries the schedule and the labeled summary block, schedule columns unchanged', () => {
    const schedule = buildSchedule(WESTBROOK_R2, CONFIG_FL)
    const csv = buildCsv(schedule, WESTBROOK_R2, CONFIG_FL)
    const [header] = csv.split('\n')
    expect(header).toBe(
      'Quarter,Projected Call,LP-net Distribution,Net Cash Flow,Cumulative Called,Cumulative Distributed,Cumulative Net'
    )
    expect(csv).toContain('Projection Summary,Value')
    expect(csv).toContain('Preferred Entitlement')
    expect(csv).toContain('Hold Capped by Fund Life,no')
    expect(csv).toContain('Effective Peak Quarter,Q2 2030')
  })
})
