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

// ── Westbrook IV — Round 2 fixture: multi-year remaining investment period ──────
// Identical to WESTBROOK except the investment period ends 2028-06-01, ~2.2 years
// past the 2026-03-31 as-of date, so the $7M remaining call no longer collapses into
// a single quarter. First fixture to drive both call-pacing modes through the full
// schedule → liquidity → waterfall path. WESTBROOK itself is untouched above — its
// hand-computed carry expectations must keep passing unchanged.
const WESTBROOK_R2: ConfirmedFields = {
  ...WESTBROOK,
  investmentPeriodEndDate: '2028-06-01',
}

// Nine forward call quarters, Q2 2026 through the quarter containing IP end.
const R2_CALL_QUARTERS = [
  '2026-06-30', '2026-09-30', '2026-12-31', '2027-03-31', '2027-06-30',
  '2027-09-30', '2027-12-31', '2028-03-31', '2028-06-30',
]

// Observed deployment pace: $18M called across 11 distinct historical quarters.
const R2_HIST_AVG = 18_000_000 / 11 // ≈ $1.636M per quarter

describe('WESTBROOK_R2 — front-loaded call pacing over a multi-year IP (Round 2)', () => {
  const calls = projectCalls(WESTBROOK_R2, CONFIG)

  it('spreads across all nine quarters to IP end — no single-quarter dump', () => {
    expect(calls.map(c => c.date)).toEqual(R2_CALL_QUARTERS)
    for (const c of calls) {
      expect(c.amount).toBeGreaterThan(0)
      expect(c.amount).toBeLessThan(WESTBROOK_R2.unfundedCommitment)
    }
  })

  it('sums to exactly the $7M remaining unfunded', () => {
    expect(sum(calls.map(c => c.amount))).toBeCloseTo(7_000_000, 2)
  })

  it('declines geometrically from the largest first quarter at decay 0.7', () => {
    // First-quarter weight 1 of Σ 0.7^i (i = 0..8): 7M / ((1 − 0.7^9) / 0.3) ≈ $2.188M.
    expect(calls[0].amount).toBeCloseTo(7_000_000 / ((1 - 0.7 ** 9) / 0.3), 1)
    for (let i = 1; i < calls.length; i++) {
      expect(calls[i].amount).toBeLessThan(calls[i - 1].amount)
      expect(calls[i].amount / calls[i - 1].amount).toBeCloseTo(0.7, 6)
    }
  })
})

describe('WESTBROOK_R2 — history-fit call pacing (Round 2)', () => {
  const calls = projectCalls(WESTBROOK_R2, { ...CONFIG, callCurve: 'history-fit' })

  it('matches the observed historical average pace while unfunded remains', () => {
    // $18M over 11 distinct quarters ≈ $1.636M per quarter for the first four quarters.
    for (let i = 0; i < 4; i++) expect(calls[i].amount).toBeCloseTo(R2_HIST_AVG, 2)
  })

  it('caps by remaining unfunded, then stops calling', () => {
    // Unfunded is exhausted mid-schedule: quarter 5 takes the $454,545 remainder
    // (7M − 4 × avg) and quarters 6–9 call nothing. The end-of-IP residual branch
    // (pace too slow to finish) is covered by the round-1 history-fit test above.
    expect(calls[4].amount).toBeCloseTo(7_000_000 - 4 * R2_HIST_AVG, 2)
    for (let i = 5; i < calls.length; i++) expect(calls[i].amount).toBe(0)
    let cumulative = 0
    for (const c of calls) {
      cumulative += c.amount
      expect(cumulative).toBeLessThanOrEqual(WESTBROOK_R2.unfundedCommitment + 1e-6)
    }
  })

  it('sums to exactly the $7M remaining unfunded', () => {
    expect(sum(calls.map(c => c.amount))).toBeCloseTo(7_000_000, 2)
  })

  it('produces a visibly different schedule from front-loaded on the same fixture', () => {
    const frontLoaded = projectCalls(WESTBROOK_R2, CONFIG)
    expect(frontLoaded.map(c => c.amount)).not.toEqual(calls.map(c => c.amount))
    // First quarter: front-loaded ≈ $2.188M vs history-fit ≈ $1.636M.
    expect(Math.abs(frontLoaded[0].amount - calls[0].amount)).toBeGreaterThan(500_000)
  })
})

describe('WESTBROOK_R2 — end-to-end regression (Round 2, Item 2 checklist)', () => {
  // Round-1 defaults with the call multiple active (1.4 on future-called capital).
  const R2_CONFIG: PacingConfig = { ...CONFIG, forwardCallMultiple: 1.4 }
  const scheduleFL = buildSchedule(WESTBROOK_R2, R2_CONFIG)
  const scheduleHF = buildSchedule(WESTBROOK_R2, { ...R2_CONFIG, callCurve: 'history-fit' })
  const liqFL = buildLiquidityView(scheduleFL, WESTBROOK_R2)
  const liqHF = buildLiquidityView(scheduleHF, WESTBROOK_R2)

  it('1. calls spread across multiple quarters in both modes', () => {
    const callQuarters = (s: typeof scheduleFL) => s.periods.filter(p => p.call > 0)
    expect(callQuarters(scheduleFL)).toHaveLength(9)
    expect(callQuarters(scheduleHF)).toHaveLength(5)
    for (const s of [scheduleFL, scheduleHF]) {
      expect(Math.max(...s.periods.map(p => p.call))).toBeLessThan(7_000_000)
    }
  })

  it('2. distributions rise to a peak positioned by avgRemainingHoldYears, then taper', () => {
    // Peak index = 4 years × 4 quarters = 16 → 2030-06-30 on the 21-quarter grid.
    const amounts = scheduleFL.periods.map(p => p.distribution)
    const peakIdx = amounts.indexOf(Math.max(...amounts))
    expect(peakIdx).toBe(16)
    expect(scheduleFL.periods[peakIdx].date).toBe('2030-06-30')
    expect(peakIdx).toBeLessThan(amounts.length - 1) // final quarter is not the maximum
    for (let i = 1; i <= peakIdx; i++) expect(amounts[i]).toBeGreaterThan(amounts[i - 1])
    for (let i = peakIdx + 1; i < amounts.length; i++) {
      expect(amounts[i]).toBeLessThan(amounts[i - 1])
    }
  })

  it('3. distributions are net of carry; carry binds, so the conditional label state is "net of carry"', () => {
    // Distribution track is independent of call timing, so the hand-computed WESTBROOK
    // figures at call multiple 1.4 carry over exactly: gross 45.2M, ROC 25M (18M called
    // + 7M future), profit above ROC 20.2M, pref ≈ 12.67M < 20.2M → full catch-up →
    // gpCarry = 0.20 × 20.2M = 4.04M; lifetime LP-net 41.16M; future LP-net 36.96M.
    for (const s of [scheduleFL, scheduleHF]) {
      const gpCarry = s.distributionBreakdown.gpCatchUp + s.distributionBreakdown.gpProfitSplit
      expect(gpCarry).toBeCloseTo(4_040_000, 0)
      expect(s.lifetimeLpNet).toBeCloseTo(41_160_000, 0)
      expect(s.futureLpNet).toBeCloseTo(36_960_000, 0)
      // The narrative route's conditional label reads carryBindsInProjection =
      // gpCarryProjected > 0 — carry binds on this fixture, so "net of carry" shows.
      expect(gpCarry).toBeGreaterThan(0)
    }
  })

  it('4. peak funding need ≤ remaining unfunded, computed on the forward-only series', () => {
    // Both modes trough forward at 2027-03-31: FL ≈ $4.67M, HF ≈ $5.67M — well under
    // the $7M dry-powder bound, and far below the lifetime trough (≈ $18.5M / $19.5M),
    // which bundles sunk capital and is deliberately not this metric.
    for (const [liq, schedule] of [[liqFL, scheduleFL], [liqHF, scheduleHF]] as const) {
      expect(liq.peakFundingNeed!.value).toBeGreaterThan(0)
      expect(liq.peakFundingNeed!.value).toBeLessThanOrEqual(7_000_000)
      expect(liq.peakFundingNeed!.date > WESTBROOK_R2.asOfDate).toBe(true)
      expect(liq.peakFundingNeed!.value).toBeLessThan(-schedule.trough!.value)
    }
    expect(liqFL.peakFundingNeed!.date).toBe('2027-03-31')
    expect(liqFL.peakFundingNeed!.value).toBeCloseTo(4_671_200.84, 1)
    expect(liqHF.peakFundingNeed!.date).toBe('2027-03-31')
    expect(liqHF.peakFundingNeed!.value).toBeCloseTo(5_673_676.18, 1)
  })

  it('5. crossover on the lifetime series — DPI = 1.0 breakeven at Q3 2029', () => {
    // Hand-sum of lifetime cumulative net: opens at 4.2M − 18M = −13.8M, all $7M of
    // calls land by Q2 2028 (−20.8M cumulative outflow lifetime), and cumulative
    // distributions (ITD 4.2M + projected) first exceed cumulative called at
    // 2029-09-30: cumNet moves −2,787,566 → +468,816 on a $3,256,382 distribution.
    // Identical in both modes — by Q3 2029 all calls are behind the LP either way.
    for (const s of [scheduleFL, scheduleHF]) {
      expect(s.crossover?.date).toBe('2029-09-30')
      const firstNonNegative = s.periods.find(p => p.cumulativeNet >= 0)
      expect(firstNonNegative?.date).toBe('2029-09-30')
    }
  })

  it('6. sum-preservation to the penny — reshaping leaks nothing', () => {
    // Projected future gross = (NAV × nav_multiple) + (future_called × call_multiple)
    //                        = 19.5M × 1.6 + 7M × 1.4 = $41.0M.
    const expectedFutureGross = 19_500_000 * 1.6 + 7_000_000 * 1.4
    for (const s of [scheduleFL, scheduleHF]) {
      const gpCarry = s.distributionBreakdown.gpCatchUp + s.distributionBreakdown.gpProfitSplit
      // The schedule is LP-net: per-period distributions sum to futureLpNet
      // (= lifetimeLpNet − distributionsToDate), NOT to the two-term gross —
      // the gap between the two is exactly the GP's carry.
      expect(s.futureLpNet).toBeCloseTo(s.lifetimeLpNet - WESTBROOK_R2.distributionsToDate, 2)
      expect(s.totalProjectedDistributions).toBeCloseTo(s.futureLpNet, 2)
      // Gross-level identity: futureLpNet + gpCarry + distributionsToDate =
      // (NAV × nav_multiple) + (future_called × call_multiple) + distributionsToDate.
      expect(s.futureLpNet + gpCarry + WESTBROOK_R2.distributionsToDate).toBeCloseTo(
        expectedFutureGross + WESTBROOK_R2.distributionsToDate, 2
      )
      // And the call track deploys exactly the unfunded commitment.
      expect(s.totalProjectedCalls).toBeCloseTo(7_000_000, 2)
    }
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
