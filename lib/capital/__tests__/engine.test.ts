import { describe, it, expect } from 'vitest'
import type { ConfirmedFields, PacingConfig } from '../scheduleTypes'
import { projectCalls } from '../callPacing'
import { projectDistributions } from '../distributionPacing'
import { buildSchedule } from '../schedule'
import { buildLiquidityView } from '../liquidityView'
import { deriveCapitalFields, normalizeMagnitude } from '../extractionUtils'

// ── Synthetic single-PE-fund LP fixture ─────────────────────────────────────────
// Commitment 10M, called 6M → unfunded 4M, distributions ITD 2M, NAV 7M.
// Vintage 2021, as-of mid-2026, IP ends end-2026, fund ends end-2031.
const FIELDS: ConfirmedFields = {
  fundName: 'Test Buyout Fund III',
  currency: 'USD',
  asOfDate: '2026-06-30',
  vintageDate: '2021-01-01',
  investmentPeriodEndDate: '2026-12-31',
  fundEndDate: '2031-12-31',
  commitment: 10_000_000,
  calledToDate: 6_000_000,
  unfundedCommitment: 4_000_000,
  distributionsToDate: 2_000_000,
  currentNav: 7_000_000,
  fundTerms: {
    hurdleRate: 0.08,
    carryRate: 0.2,
    catchUp: 'full',
    preferredCompounding: 'compound',
  },
  historicalCalls: [],
  historicalDistributions: [],
}

const CONFIG: PacingConfig = {
  callCurve: 'front-loaded',
  callDecay: 0.7,
  forwardValueMultiple: 1.6,
  avgRemainingHoldYears: 4,
  overrides: [],
}

const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0)

describe('callPacing — front-loaded', () => {
  const calls = projectCalls(FIELDS, CONFIG)

  it('runs from as-of to IP end (two quarters)', () => {
    expect(calls.map(c => c.date)).toEqual(['2026-09-30', '2026-12-31'])
  })

  it('distributes exactly the unfunded commitment', () => {
    expect(sum(calls.map(c => c.amount))).toBeCloseTo(4_000_000, 2)
  })

  it('front-loads (first quarter larger than the next)', () => {
    expect(calls[0].amount).toBeGreaterThan(calls[1].amount)
    expect(calls[0].amount).toBeCloseTo(4_000_000 / 1.7, 1) // weight 1 of [1, 0.7]
  })
})

describe('callPacing — history-fit', () => {
  it('projects at the observed pace and deploys the full unfunded', () => {
    const fields: ConfirmedFields = {
      ...FIELDS,
      historicalCalls: [
        { date: '2024-03-31', amount: 1_500_000 },
        { date: '2024-06-30', amount: 1_500_000 },
      ],
    }
    const calls = projectCalls(fields, { ...CONFIG, callCurve: 'history-fit' })
    expect(calls).toHaveLength(2)
    expect(calls[0].amount).toBeCloseTo(1_500_000, 2) // observed avg per quarter
    expect(sum(calls.map(c => c.amount))).toBeCloseTo(4_000_000, 2) // residual into last quarter
  })
})

describe('distributionPacing — J-curve, net of carry', () => {
  const dist = projectDistributions(FIELDS, CONFIG)

  it('grosses up NAV by the forward multiple, nets of carry over the whole fund', () => {
    // gross = 2M ITD + 7M × 1.6 = 13.2M; LP has not cleared full pref → all to LP, no carry
    expect(dist.lifetimeLpNet).toBeCloseTo(13_200_000, 0)
    expect(dist.breakdown.gpCatchUp).toBe(0)
    expect(dist.breakdown.gpProfitSplit).toBe(0)
  })

  it('releases future net-of-carry = lifetime LP-net − distributions received', () => {
    expect(dist.futureLpNet).toBeCloseTo(11_200_000, 0)
    expect(sum(dist.periods.map(p => p.amount))).toBeCloseTo(11_200_000, 0)
  })

  it('follows a J-curve: ramps to a peak, tapers to zero at fund end', () => {
    const amounts = dist.periods.map(p => p.amount)
    const peakIdx = amounts.indexOf(Math.max(...amounts))
    expect(peakIdx).toBe(16) // avgRemainingHoldYears 4 × 4 quarters
    expect(amounts[0]).toBeLessThan(amounts[peakIdx])         // early-life trough
    expect(amounts.at(-1)!).toBeLessThan(amounts[peakIdx])    // taper
    expect(amounts.at(-1)!).toBeCloseTo(0, 6)                 // zero at fund end
  })
})

describe('buildSchedule — orchestration', () => {
  const schedule = buildSchedule(FIELDS, CONFIG)

  it('opens running positions from ITD actuals', () => {
    expect(schedule.openingCumulativeNet).toBe(-4_000_000) // 2M distributed − 6M called
  })

  it('totals reconcile with the two tracks', () => {
    expect(schedule.totalProjectedCalls).toBeCloseTo(4_000_000, 0)
    expect(schedule.totalProjectedDistributions).toBeCloseTo(11_200_000, 0)
  })

  it('troughs after the early calls, then crosses over to net-positive', () => {
    expect(schedule.trough?.date).toBe('2026-12-31')
    expect(schedule.trough?.value).toBeLessThan(-7_800_000)
    expect(schedule.trough?.value).toBeGreaterThan(-7_850_000)
    expect(schedule.crossover).not.toBeNull()
    // ends net-positive: opening −4M − calls 4M + distributions 11.2M = 3.2M
    expect(schedule.periods.at(-1)!.cumulativeNet).toBeCloseTo(3_200_000, 0)
  })

  it('honors per-period overrides', () => {
    const overridden = buildSchedule(FIELDS, {
      ...CONFIG,
      overrides: [{ date: '2026-09-30', call: 1_000_000 }],
    })
    const q3 = overridden.periods.find(p => p.date === '2026-09-30')!
    expect(q3.call).toBe(1_000_000)
    expect(q3.callOverridden).toBe(true)
    expect(overridden.totalProjectedCalls).toBeCloseTo(1_000_000 + 4_000_000 / 1.7 * 0.7, 0)
  })
})

describe('buildLiquidityView — treasury', () => {
  const schedule = buildSchedule(FIELDS, CONFIG)
  const liq = buildLiquidityView(schedule, FIELDS)

  it('draws the unfunded balance to zero across the call quarters', () => {
    expect(liq.openingUnfunded).toBe(4_000_000)
    expect(liq.periods.find(p => p.date === '2026-12-31')!.runningUnfunded).toBeCloseTo(0, 2)
  })

  it('surfaces rolling liquidity required over the next N quarters', () => {
    const next4 = liq.rollingLiquidityRequired.find(r => r.quarters === 4)!
    expect(next4.amount).toBeCloseTo(4_000_000, 0) // both calls fall in the next year
  })

  it('reports peak funding need as the positive of the trough', () => {
    expect(liq.peakFundingNeed?.value).toBeCloseTo(-(schedule.trough!.value), 2)
  })
})

describe('deriveCapitalFields — called/unfunded/commitment triangle', () => {
  it('derives called from commitment and unfunded', () => {
    const r = deriveCapitalFields({ commitment: 10_000_000, calledToDate: null, unfundedCommitment: 4_000_000 })
    expect(r.calledToDate).toBe(6_000_000)
    expect(r.derived).toContain('calledToDate')
  })

  it('derives unfunded from commitment and called', () => {
    const r = deriveCapitalFields({ commitment: 10_000_000, calledToDate: 6_000_000, unfundedCommitment: null })
    expect(r.unfundedCommitment).toBe(4_000_000)
    expect(r.derived).toContain('unfundedCommitment')
  })

  it('leaves fields blank when only commitment is known', () => {
    const r = deriveCapitalFields({ commitment: 10_000_000, calledToDate: null, unfundedCommitment: null })
    expect(r.calledToDate).toBeNull()
    expect(r.unfundedCommitment).toBeNull()
    expect(r.derived).toHaveLength(0)
  })

  it('normalizes signed magnitudes', () => {
    expect(normalizeMagnitude(-2_500_000)).toBe(2_500_000)
    expect(normalizeMagnitude(null)).toBeNull()
  })
})
