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
  forwardCallMultiple: 0, // NAV-only base unless a test overrides it
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
    // gross = 2M ITD + 7M × 1.6 = 13.2M. No dated history on this fixture, so preferred
    // accrues on the synthetic fallback (6M paid-in at vintage, 2M distributed at as-of)
    // = ~4.93M — below the 7.2M profit above ROC, so the GP fully catches up and carry
    // binds. With full catch-up and pref ≤ profit-above-ROC, gpCarry = carry × (gross − paidIn)
    // = 0.2 × (13.2M − 6M) = 1.44M, so lpNet = 13.2M − 1.44M = 11.76M.
    expect(dist.lifetimeLpNet).toBeCloseTo(11_760_000, 0)
    expect(dist.breakdown.gpCatchUp + dist.breakdown.gpProfitSplit).toBeCloseTo(1_440_000, 0)
  })

  it('releases future net-of-carry = lifetime LP-net − distributions received', () => {
    expect(dist.futureLpNet).toBeCloseTo(9_760_000, 0)
    expect(sum(dist.periods.map(p => p.amount))).toBeCloseTo(9_760_000, 0)
  })

  it('follows a J-curve: ramps to a peak, tapers to zero at fund end', () => {
    const amounts = dist.periods.map(p => p.amount)
    const peakIdx = amounts.indexOf(Math.max(...amounts))
    expect(peakIdx).toBe(16) // avgRemainingHoldYears 4 × 4 quarters
    expect(amounts[0]).toBeLessThan(amounts[peakIdx])         // early-life trough
    expect(amounts.at(-1)!).toBeLessThan(amounts[peakIdx])    // taper
    expect(amounts.at(-1)!).toBeCloseTo(0, 6)                 // zero at fund end
  })

  it('avgRemainingHold positions the peak — different holds, different peak quarters', () => {
    const peakOf = (years: number) => {
      const amounts = projectDistributions(FIELDS, { ...CONFIG, avgRemainingHoldYears: years })
        .periods.map(p => p.amount)
      return amounts.indexOf(Math.max(...amounts))
    }
    const peakShort = peakOf(2)
    const peakLong = peakOf(4)
    expect(peakShort).toBe(8)            // 2y × 4 quarters
    expect(peakLong).toBe(16)            // 4y × 4 quarters
    expect(peakLong).toBeGreaterThan(peakShort) // a longer hold pushes exits later
  })

  it('never spikes the largest distribution in the final quarter (peak-and-taper)', () => {
    // Default hold (5y) on this ~5.5y-remaining fixture: the old linear ramp peaked
    // at the last quarter; the bell caps the peak inside the horizon and tapers.
    const amounts = projectDistributions(FIELDS, { ...CONFIG, avgRemainingHoldYears: 5 })
      .periods.map(p => p.amount)
    const peakIdx = amounts.indexOf(Math.max(...amounts))
    expect(peakIdx).toBeLessThan(amounts.length - 1)
    expect(amounts.at(-1)!).toBeLessThan(amounts[peakIdx])
  })
})

// ── Westbrook Capital Partners IV / Cedar Point Foundation ───────────────────────
// The round-1 test fixture, with its full dated contribution/distribution history.
// Commitment 25M, called 18M, distributions 4.2M, NAV 19.5M. Vintage Jun 2021,
// fund end Jun 2031. Hand-computed carry on the full lifetime gross below.
const WESTBROOK: ConfirmedFields = {
  fundName: 'Westbrook Capital Partners IV, L.P.',
  currency: 'USD',
  asOfDate: '2026-03-31',
  vintageDate: '2021-06-01',
  investmentPeriodEndDate: '2026-06-01',
  fundEndDate: '2031-06-01',
  commitment: 25_000_000,
  calledToDate: 18_000_000,
  unfundedCommitment: 7_000_000,
  distributionsToDate: 4_200_000,
  currentNav: 19_500_000,
  fundTerms: {
    hurdleRate: 0.08,
    carryRate: 0.2,
    catchUp: 'full',
    preferredCompounding: 'compound',
  },
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

describe('distributionPacing — carry deducted on the Westbrook fixture', () => {
  const dist = projectDistributions(WESTBROOK, CONFIG)

  it('deducts GP carry once the LP clears return of capital + preferred', () => {
    // Lifetime gross = 4.2M ITD + 19.5M × 1.6 = 35.4M.
    // Return of capital = 18M paid-in → profit above ROC = 17.4M.
    // Preferred (outstanding-capital basis on the dated history) ≈ 9.25M < 17.4M, so the
    // GP fully catches up. With full catch-up and pref ≤ profit-above-ROC the GP ends with
    // exactly carry% of profit above ROC:  gpCarry = 0.20 × (35.4M − 18M) = 3.48M.
    const gpCarry = dist.breakdown.gpCatchUp + dist.breakdown.gpProfitSplit
    expect(gpCarry).toBeCloseTo(3_480_000, 0)

    // lpNet = ROC + pref + LP profit split = 18M + 0.80 × 17.4M = 31.92M.
    expect(dist.lifetimeLpNet).toBeCloseTo(31_920_000, 0)

    // Future net-of-carry = lifetime LP-net − distributions already received.
    expect(dist.futureLpNet).toBeCloseTo(27_720_000, 0)
  })

  it('keeps projected distributions strictly below gross when carry binds', () => {
    const projectedGross = 19_500_000 * CONFIG.forwardValueMultiple
    expect(dist.futureLpNet).toBeLessThan(projectedGross)
  })
})

describe('distributionPacing — forward multiple on called capital (Fix 3)', () => {
  // Strip carry & hurdle so LP-net == gross, isolating the two-term gross formula.
  const noWaterfall: ConfirmedFields = {
    ...WESTBROOK,
    fundTerms: { ...WESTBROOK.fundTerms, carryRate: 0, hurdleRate: 0 },
  }

  it('adds future-called capital to the base: gross = NAV×navMult + called×callMult', () => {
    const d = projectDistributions(noWaterfall, {
      ...CONFIG,
      forwardValueMultiple: 1.6,
      forwardCallMultiple: 1.4,
    })
    // projected future gross = 19.5×1.6 + 7×1.4 = 31.2 + 9.8 = 41.0M; LP-net == gross here.
    expect(d.futureLpNet).toBeCloseTo(41_000_000, 0)
  })

  it('call_multiple = 0 reproduces the NAV-only base (backward compatible)', () => {
    const d = projectDistributions(noWaterfall, {
      ...CONFIG,
      forwardValueMultiple: 1.6,
      forwardCallMultiple: 0,
    })
    expect(d.futureLpNet).toBeCloseTo(31_200_000, 0) // 19.5×1.6 only
  })

  it('carries the larger two-term profit tranche, counting future capital in ROC', () => {
    const d = projectDistributions(WESTBROOK, { ...CONFIG, forwardCallMultiple: 1.4 })
    // gross 45.2M; ROC = 18M called + 7M future = 25M; profit above ROC = 20.2M.
    // Preferred (~12.7M) < profit above ROC, so full catch-up → gpCarry = 0.20 × 20.2M = 4.04M.
    const gpCarry = d.breakdown.gpCatchUp + d.breakdown.gpProfitSplit
    expect(gpCarry).toBeCloseTo(4_040_000, 0)
    expect(d.lifetimeLpNet).toBeCloseTo(41_160_000, 0)
    expect(d.futureLpNet).toBeCloseTo(36_960_000, 0)
  })

  it('does not carry the LP’s own returned future capital (vs. ignoring ROC basis)', () => {
    // If future capital were added to gross but NOT to ROC, profit above ROC would be
    // 45.2M − 18M = 27.2M → carry 5.44M. Counting it in ROC keeps carry at 4.04M.
    const d = projectDistributions(WESTBROOK, { ...CONFIG, forwardCallMultiple: 1.4 })
    const gpCarry = d.breakdown.gpCatchUp + d.breakdown.gpProfitSplit
    expect(gpCarry).toBeLessThan(5_440_000)
  })
})

describe('buildSchedule — orchestration', () => {
  const schedule = buildSchedule(FIELDS, CONFIG)

  it('opens running positions from ITD actuals', () => {
    expect(schedule.openingCumulativeNet).toBe(-4_000_000) // 2M distributed − 6M called
  })

  it('totals reconcile with the two tracks', () => {
    expect(schedule.totalProjectedCalls).toBeCloseTo(4_000_000, 0)
    expect(schedule.totalProjectedDistributions).toBeCloseTo(9_760_000, 0)
  })

  it('troughs after the early calls, then crosses over to net-positive', () => {
    expect(schedule.trough?.date).toBe('2026-12-31')
    expect(schedule.trough?.value).toBeLessThan(-7_950_000)
    expect(schedule.trough?.value).toBeGreaterThan(-7_970_000)
    expect(schedule.crossover).not.toBeNull()
    // ends net-positive: opening −4M − calls 4M + distributions 9.76M = 1.76M
    expect(schedule.periods.at(-1)!.cumulativeNet).toBeCloseTo(1_760_000, 0)
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

  it('reports peak funding need from the forward-only series, bounded by unfunded', () => {
    // Forward funding need is the deepest forward cumulative net — NOT the lifetime trough
    // (which bundles already-funded, sunk capital). It can never exceed remaining unfunded.
    expect(liq.peakFundingNeed!.value).toBeGreaterThan(0)
    expect(liq.peakFundingNeed!.value).toBeLessThanOrEqual(liq.openingUnfunded)
    // Strictly shallower than the lifetime trough, which opens at −4M (already funded).
    expect(liq.peakFundingNeed!.value).toBeLessThan(-(schedule.trough!.value))
    // And it lands on a forward quarter, not the as-of opening position.
    expect(liq.peakFundingNeed!.date > FIELDS.asOfDate).toBe(true)
  })
})

describe('Fix 4 — forward peak funding need vs. lifetime crossover', () => {
  const schedule = buildSchedule(WESTBROOK, { ...CONFIG, forwardCallMultiple: 1.4 })
  const liq = buildLiquidityView(schedule, WESTBROOK)

  it('peak funding need ≤ remaining unfunded (forward dry-powder bound)', () => {
    expect(liq.peakFundingNeed!.value).toBeGreaterThan(0)
    expect(liq.peakFundingNeed!.value).toBeLessThanOrEqual(WESTBROOK.unfundedCommitment)
    // Opening lifetime position is −13.8M (18M called − 4.2M distributed); the old metric
    // would have read ~$13.8M+. The forward figure is bounded by the $7M unfunded.
    expect(liq.peakFundingNeed!.value).toBeLessThan(-(schedule.trough!.value))
  })

  it('crossover stays on the lifetime series (unchanged by the forward-peak split)', () => {
    // Crossover is the first quarter lifetime cumulative net turns non-negative.
    const expected = schedule.periods.find(p => p.cumulativeNet >= 0)
    expect(schedule.crossover?.date).toBe(expected?.date ?? undefined)
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
