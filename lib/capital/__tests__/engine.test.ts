import { describe, it, expect } from 'vitest'
import type { ConfirmedFields, PacingConfig } from '../scheduleTypes'
import { projectCalls } from '../callPacing'
import { projectDistributions, holdCapInfo } from '../distributionPacing'
import { buildSchedule } from '../schedule'
import { buildLiquidityView } from '../liquidityView'
import { deriveCapitalFields, normalizeMagnitude } from '../extractionUtils'

// projectDistributions requires the projected call series as of engine 1.2.0 — the
// preferred accrual reads future contributions off the actual projected call dates,
// which makes the waterfall pacing-mode-dependent (round 3, Item 1). Tests that
// exercise the distribution track alone still need the matching call series.
const distOf = (fields: ConfirmedFields, config: PacingConfig) =>
  projectDistributions(fields, config, projectCalls(fields, config))

const gpCarryOf = (d: { breakdown: { gpCatchUp: number; gpProfitSplit: number } }) =>
  d.breakdown.gpCatchUp + d.breakdown.gpProfitSplit

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
  const dist = distOf(FIELDS, CONFIG)

  it('grosses up NAV by the forward multiple, nets of carry over the whole fund', () => {
    // gross = 2M ITD + 7M × 1.6 = 13.2M. No dated history on this fixture, so preferred
    // accrues on the synthetic fallback under ROC-first crediting (engine 1.2.0):
    //   +6M at vintage 2021-01-01 → accrues 5.4921y to as-of: 6M × (1.08^5.4921 − 1)
    //     = 3,156,274.76 accrued
    //   −2M at as-of 2026-06-30 returns capital (ROC-first): capital 6M → 4M,
    //     accrued untouched
    //   tail 5.5031y on (4M + 3,156,274.76) to 2031-12-31 (fund end is already a
    //     quarter-end, so Item 2 changes nothing here):
    //   entitlement = 3,156,274.76 + 7,156,274.76 × (1.08^5.5031 − 1) = 6,930,011.27
    // Tiers on 13.2M: ROC 6M → profit 7.2M; pref 6,930,011.27; remaining 269,988.73
    // is BELOW the catch-up target (0.25 × pref = 1,732,502.82), so the GP catch-up is
    // partial and the residual never splits:
    //   gpCarry = 269,988.73 ; lpNet = 6M + 6,930,011.27 = 12,930,011.27.
    expect(dist.preferredEntitlement).toBeCloseTo(6_930_011.27, 1)
    expect(dist.lifetimeLpNet).toBeCloseTo(12_930_011.27, 1)
    expect(gpCarryOf(dist)).toBeCloseTo(269_988.73, 1)
  })

  it('releases future net-of-carry = lifetime LP-net − distributions received', () => {
    expect(dist.futureLpNet).toBeCloseTo(10_930_011.27, 1)
    expect(sum(dist.periods.map(p => p.amount))).toBeCloseTo(10_930_011.27, 1)
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
      const amounts = distOf(FIELDS, { ...CONFIG, avgRemainingHoldYears: years })
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
    const amounts = distOf(FIELDS, { ...CONFIG, avgRemainingHoldYears: 5 })
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
  const dist = distOf(WESTBROOK, CONFIG)

  it('deducts GP carry once the LP clears return of capital + preferred', () => {
    // Lifetime gross = 4.2M ITD + 19.5M × 1.6 = 35.4M (call multiple 0 in CONFIG, so no
    // future-called capital in gross, basis, or accrual).
    // Return of capital = 18M paid-in → profit above ROC = 17.4M.
    // Preferred under ROC-first crediting (engine 1.2.0): the dated event walk credits
    // each of the $4.2M of historical distributions against unreturned capital (capital
    // ends at 18M − 4.2M = 13.8M; accrued is never paid down), and the tail runs to the
    // quarter-end horizon 2031-06-30 (Item 2):
    //   entitlement = 13,621,513.82.
    // Remaining after pref = 17.4M − 13,621,513.82 = 3,778,486.18 still EXCEEDS the
    // catch-up target 0.25 × 13,621,513.82 = 3,405,378.46, so the GP fully catches up
    // and the carry-invariance property holds: gpCarry = 0.20 × 17.4M = 3.48M exactly —
    // this round-1 expectation deliberately survives the convention change.
    //   (catch-up 3,405,378.46 + residual split 373,107.72 × 20% = 74,621.54 → 3.48M)
    expect(dist.preferredEntitlement).toBeCloseTo(13_621_513.82, 1)
    expect(gpCarryOf(dist)).toBeCloseTo(3_480_000, 0)

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
    const d = distOf(noWaterfall, {
      ...CONFIG,
      forwardValueMultiple: 1.6,
      forwardCallMultiple: 1.4,
    })
    // projected future gross = 19.5×1.6 + 7×1.4 = 31.2 + 9.8 = 41.0M; LP-net == gross here.
    expect(d.futureLpNet).toBeCloseTo(41_000_000, 0)
  })

  it('call_multiple = 0 reproduces the NAV-only base (backward compatible)', () => {
    const d = distOf(noWaterfall, {
      ...CONFIG,
      forwardValueMultiple: 1.6,
      forwardCallMultiple: 0,
    })
    expect(d.futureLpNet).toBeCloseTo(31_200_000, 0) // 19.5×1.6 only
  })

  it('carries the two-term profit tranche, counting future capital in ROC', () => {
    const d = distOf(WESTBROOK, { ...CONFIG, forwardCallMultiple: 1.4 })
    // gross 45.2M; ROC = 18M called + 7M future = 25M; profit above ROC = 20.2M.
    // WESTBROOK's IP ends 2026-06-01, so the whole $7M future call lands in the single
    // forward quarter 2026-06-30 and accrues from that date (engine 1.2.0 — actual call
    // dates, not an as-of lump). ROC-first event walk to the 2031-06-30 horizon:
    //   entitlement = 16,906,268.58.
    // Remaining after pref = 20.2M − 16,906,268.58 = 3,293,731.42 is BELOW the catch-up
    // target 0.25 × 16,906,268.58 = 4,226,567.15 → catch-up is PARTIAL, residual 0:
    //   gpCarry = 3,293,731.42 ; lpNet = 45.2M − 3,293,731.42 = 41,906,268.58.
    expect(d.preferredEntitlement).toBeCloseTo(16_906_268.58, 1)
    expect(gpCarryOf(d)).toBeCloseTo(3_293_731.42, 1)
    expect(d.lifetimeLpNet).toBeCloseTo(41_906_268.58, 1)
    expect(d.futureLpNet).toBeCloseTo(37_706_268.58, 1)
  })

  it('does not carry the LP’s own returned future capital (vs. ignoring ROC basis)', () => {
    // If future capital were added to gross but NOT to ROC, profit above ROC would be
    // 45.2M − 18M = 27.2M → carry up to 5.44M. Counting it in ROC keeps carry far below.
    const d = distOf(WESTBROOK, { ...CONFIG, forwardCallMultiple: 1.4 })
    expect(gpCarryOf(d)).toBeLessThan(5_440_000)
  })
})

describe('buildSchedule — orchestration', () => {
  const schedule = buildSchedule(FIELDS, CONFIG)

  it('opens running positions from ITD actuals', () => {
    expect(schedule.openingCumulativeNet).toBe(-4_000_000) // 2M distributed − 6M called
  })

  it('totals reconcile with the two tracks', () => {
    expect(schedule.totalProjectedCalls).toBeCloseTo(4_000_000, 0)
    // futureLpNet under the round-3 convention (worked math in the J-curve describe).
    expect(schedule.totalProjectedDistributions).toBeCloseTo(10_930_011.27, 1)
  })

  it('troughs after the early calls, then crosses over to net-positive', () => {
    expect(schedule.trough?.date).toBe('2026-12-31')
    // Opens at −4M, both calls (2.353M + 1.647M) land by Q4 2026 against 42,008.34 of
    // early distributions: trough = −4M − 4M + 42,008.34 = −7,957,991.66.
    expect(schedule.trough?.value).toBeCloseTo(-7_957_991.66, 1)
    expect(schedule.crossover).not.toBeNull()
    expect(schedule.crossover?.date).toBe('2030-09-30')
    // ends net-positive: opening −4M − calls 4M + distributions 10,930,011.27 = 2,930,011.27
    expect(schedule.periods.at(-1)!.cumulativeNet).toBeCloseTo(2_930_011.27, 1)
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
    // The distribution track is now pacing-mode-DEPENDENT (engine 1.2.0): the $7M of
    // future calls accrues preferred from the dates each mode actually deploys it, so
    // front-loaded and history-fit produce different entitlements. Worked math, both
    // modes (gross 45.2M; ROC 25M = 18M called + 7M future; profit above ROC 20.2M):
    //
    // Dated event walk (ROC-first, compound 8%, vintage 2021-06-01 → horizon 2031-06-30):
    // the 11 historical calls build capital to 14.3M while the $4.2M of historical
    // distributions return capital as they land (capital 13.8M, accrued 4,509,150.07
    // at the 2026-03-31 as-of). Future calls then contribute per mode:
    //  · FL: 9 geometric calls from 2026-06-30 ($2,188,306.04) to 2028-06-30
    //    ($126,151.49); capital tops out at 20.8M, accrued 8,841,098.55 after the last
    //    call → tail to 2031-06-30 → entitlement 16,533,347.25.
    //  · HF: 4 × $1,636,363.64 + $454,545.45 by 2027-06-30 — the same dollars arrive
    //    EARLIER, so more accrues → entitlement 16,584,370.58.
    //
    // Tiers: remaining after pref (20.2M − E) is below the catch-up target 0.25 × E in
    // both modes (FL: 3,666,652.75 < 4,133,336.81; HF: 3,615,629.42 < 4,146,092.65),
    // so catch-up is PARTIAL, the residual never splits, and gpCarry = 20.2M − E:
    //  · FL: gpCarry 3,666,652.75; lifetime LP-net 41,533,347.25; future 37,333,347.25
    //  · HF: gpCarry 3,615,629.42; lifetime LP-net 41,584,370.58; future 37,384,370.58
    //
    // Cross-check: the adversarial band for corrected future LP-net was
    // $37.106M–$37.157M computed with accrual stopping at raw fund end 2031-06-01;
    // Item 2 extends the tail 29 days to the 2031-06-30 grid horizon, adding
    // ~$227.4K/$227.7K of entitlement which flows dollar-for-dollar to the LP because
    // catch-up is partial. Deviation traced in the round-3 delta memo.
    expect(scheduleFL.preferredEntitlement).toBeCloseTo(16_533_347.25, 1)
    expect(gpCarryOf({ breakdown: scheduleFL.distributionBreakdown })).toBeCloseTo(3_666_652.75, 1)
    expect(scheduleFL.lifetimeLpNet).toBeCloseTo(41_533_347.25, 1)
    expect(scheduleFL.futureLpNet).toBeCloseTo(37_333_347.25, 1)

    expect(scheduleHF.preferredEntitlement).toBeCloseTo(16_584_370.58, 1)
    expect(gpCarryOf({ breakdown: scheduleHF.distributionBreakdown })).toBeCloseTo(3_615_629.42, 1)
    expect(scheduleHF.lifetimeLpNet).toBeCloseTo(41_584_370.58, 1)
    expect(scheduleHF.futureLpNet).toBeCloseTo(37_384_370.58, 1)

    // Same dollars deployed earlier (HF) accrue MORE preferred — directional sanity.
    expect(scheduleHF.preferredEntitlement).toBeGreaterThan(scheduleFL.preferredEntitlement)

    for (const s of [scheduleFL, scheduleHF]) {
      // The narrative route's conditional label reads carryBindsInProjection =
      // gpCarryProjected > 0 — carry binds on this fixture, so "net of carry" shows.
      expect(gpCarryOf({ breakdown: s.distributionBreakdown })).toBeGreaterThan(0)
    }
  })

  it('4. peak funding need ≤ remaining unfunded, computed on the forward-only series', () => {
    // Both modes trough forward at 2027-03-31 — under the $7M dry-powder bound, and far
    // below the lifetime trough, which bundles sunk capital and is deliberately not this
    // metric. Values shift slightly vs round 2 because the larger LP-net (Item 1 swings
    // carry back to the LP) raises the early distributions offsetting the calls.
    for (const [liq, schedule] of [[liqFL, scheduleFL], [liqHF, scheduleHF]] as const) {
      expect(liq.peakFundingNeed!.value).toBeGreaterThan(0)
      expect(liq.peakFundingNeed!.value).toBeLessThanOrEqual(7_000_000)
      expect(liq.peakFundingNeed!.date > WESTBROOK_R2.asOfDate).toBe(true)
      expect(liq.peakFundingNeed!.value).toBeLessThan(-schedule.trough!.value)
    }
    expect(liqFL.peakFundingNeed!.date).toBe('2027-03-31')
    expect(liqFL.peakFundingNeed!.value).toBeCloseTo(4_662_394.67, 1)
    expect(liqHF.peakFundingNeed!.date).toBe('2027-03-31')
    expect(liqHF.peakFundingNeed!.value).toBeCloseTo(5_663_666.52, 1)
  })

  it('5. crossover on the lifetime series — DPI = 1.0 breakeven at Q3 2029', () => {
    // Hand-sum of lifetime cumulative net: opens at 4.2M − 18M = −13.8M, all $7M of
    // calls land by Q2 2028 (−20.8M cumulative outflow lifetime), and cumulative
    // distributions (ITD 4.2M + projected) first exceed cumulative called at
    // 2029-09-30. The ~1% larger future LP-net under the round-3 convention does not
    // pull the breakeven into an earlier quarter in either mode.
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

// ── Round 3 — Item 1 property tests: the ledger and the tiers agree by construction ──
describe('Round 3 property — waterfall identities under ROC-first crediting', () => {
  const cases: Array<[string, ConfirmedFields, PacingConfig]> = [
    ['FIELDS synthetic', FIELDS, CONFIG],
    ['WESTBROOK callMult 0', WESTBROOK, CONFIG],
    ['WESTBROOK_R2 front-loaded 1.4', { ...WESTBROOK, investmentPeriodEndDate: '2028-06-01' }, { ...CONFIG, forwardCallMultiple: 1.4 }],
    ['WESTBROOK_R2 history-fit 1.4', { ...WESTBROOK, investmentPeriodEndDate: '2028-06-01' }, { ...CONFIG, forwardCallMultiple: 1.4, callCurve: 'history-fit' }],
  ]

  it('lifetimeLpNet + gpCarry === lifetimeGross to the penny', () => {
    for (const [, fields, config] of cases) {
      const d = distOf(fields, config)
      const callMult = Math.max(0, config.forwardCallMultiple)
      const lifetimeGross =
        fields.distributionsToDate +
        fields.currentNav * config.forwardValueMultiple +
        fields.unfundedCommitment * callMult
      expect(d.lifetimeLpNet + gpCarryOf(d)).toBeCloseTo(lifetimeGross, 2)
    }
  })

  it('the preferred tier consumes exactly the ledger’s final entitlement — no paid-vs-owed gap', () => {
    // ROC-first crediting makes the ledger’s final accrued balance the lifetime
    // entitlement; whenever gross reaches the tier, the tier consumes exactly it.
    for (const [, fields, config] of cases) {
      const d = distOf(fields, config)
      expect(d.breakdown.preferredReturn).toBeCloseTo(
        Math.min(d.preferredEntitlement, Math.max(0, d.lifetimeLpNet + gpCarryOf(d) - d.breakdown.returnOfCapital)),
        2
      )
      // On these fixtures gross clears ROC + pref, so the tier IS the entitlement.
      expect(d.breakdown.preferredReturn).toBeCloseTo(d.preferredEntitlement, 2)
    }
  })
})

// ── Round 3 — Item 2: one horizon, two consumers ─────────────────────────────────
describe('Round 3 Item 2 — accrual endpoint equals the final grid date', () => {
  it('holds for arbitrary fund-end inputs, including ones already on a quarter-end', () => {
    // Raw fund ends mid-quarter used to leave a gap: accrual stopped at fundEndDate
    // while the grid ran to its quarter-end ($230,915.62 of entitlement on the old
    // convention). Both now derive from quarterEndOf(fundEndDate).
    const ends: Array<[string, string]> = [
      ['2031-06-01', '2031-06-30'], // mid-quarter (the Westbrook gap)
      ['2031-06-30', '2031-06-30'], // already a quarter-end
      ['2031-12-31', '2031-12-31'], // year-end quarter-end
      ['2030-01-15', '2030-03-31'], // early in a quarter
    ]
    for (const [fundEnd, expected] of ends) {
      const d = distOf({ ...WESTBROOK, fundEndDate: fundEnd }, CONFIG)
      expect(d.accrualEndDate).toBe(expected)
      expect(d.periods.at(-1)!.date).toBe(expected)
    }
  })
})

// ── Round 3 — Item 3: the hold cap is real but no longer silent ──────────────────
describe('Round 3 Item 3 — hold-input saturation surfaced', () => {
  const R2: ConfirmedFields = { ...WESTBROOK, investmentPeriodEndDate: '2028-06-01' }
  const cfg = (hold: number): PacingConfig =>
    ({ ...CONFIG, forwardCallMultiple: 1.4, avgRemainingHoldYears: hold })

  it('hold = 1 → peak Q2 2027, not capped', () => {
    const d = distOf(R2, cfg(1))
    const amounts = d.periods.map(p => p.amount)
    expect(amounts.indexOf(Math.max(...amounts))).toBe(4) // 1y × 4 quarters
    expect(d.effectivePeakDate).toBe('2027-06-30')
    expect(d.holdCapped).toBe(false)
  })

  it('hold = 8 → peak clamps to the 80%-of-horizon cap and reports it', () => {
    const d = distOf(R2, cfg(8))
    const amounts = d.periods.map(p => p.amount)
    expect(amounts.indexOf(Math.max(...amounts))).toBe(16) // cap on the 21-quarter grid
    expect(d.effectivePeakDate).toBe('2030-06-30')
    expect(d.holdCapped).toBe(true)
  })

  it('holdCapInfo mirrors the projection cap for the Pacing pane, pre-schedule', () => {
    // 21-quarter grid → maxPeak 16 → saturation begins beyond a 4-year hold.
    expect(holdCapInfo(R2.asOfDate, R2.fundEndDate, 4)).toEqual({ capped: false, maxHoldYears: 4 })
    expect(holdCapInfo(R2.asOfDate, R2.fundEndDate, 8)).toEqual({ capped: true, maxHoldYears: 4 })
    expect(holdCapInfo(R2.asOfDate, null, 4)).toBeNull()
  })
})

// ── Round 3 — Phase 3: the adversarial report’s ten-case seeded battery ──────────
// Cases 1, 3, 4, 10 touch preferred mechanics, so their expected values were
// recomputed under the 1.2.0 convention (independent dated-event-walk script; each
// case's comment shows the recomputation). Cases 2, 5–9 assert their original
// detecting assertions unchanged. Where a case's *side-column* figure in the report
// was waterfall-derived it is recomputed here and traced in the round-3 run log —
// notably case 2's "GP carry $0", which never matched either engine convention
// (carry is 3.48M with the call multiple off; flagged in the log, not a regression).
describe('Round 3 Phase-3 — seeded-discrepancy battery', () => {
  const R2: ConfirmedFields = { ...WESTBROOK, investmentPeriodEndDate: '2028-06-01' }
  const BAT: PacingConfig = { ...CONFIG, forwardCallMultiple: 1.4 }

  it('case 1 — NAV multiple 0.9×: carry cannot bind, label reads gross', () => {
    // gross = 4.2M + 19.5M × 0.9 + 7M × 1.4 = 31.55M; profit above ROC = 6.55M is fully
    // absorbed by the preferred tier (entitlement 16.53M ≫ 6.55M) → gpCarry 0,
    // future LP-net = 31.55M − 4.2M = 27.35M (matches the report — unchanged because
    // the pref tier saturates under both conventions).
    const d = distOf(R2, { ...BAT, forwardValueMultiple: 0.9 })
    expect(gpCarryOf(d)).toBe(0)
    expect(d.futureLpNet).toBeCloseTo(27_350_000, 1)
  })

  it('case 2 — call multiple 0: projected gross is exactly NAV × 1.6', () => {
    const d = distOf(R2, { ...BAT, forwardCallMultiple: 0 })
    // Detecting assertion: future gross = 19.5M × 1.6 = 31.2M, recovered from the
    // identity futureLpNet + gpCarry = future gross.
    expect(d.futureLpNet + gpCarryOf(d)).toBeCloseTo(31_200_000, 2)
    // Recomputed side value (report column said $0 — see note above): with 18M
    // paid-in and entitlement 13,621,513.82 the catch-up completes → carry 3.48M.
    expect(gpCarryOf(d)).toBeCloseTo(3_480_000, 0)
  })

  it('case 3 — unfunded $0 (commitment = called = 18M): no calls, PFN zero', () => {
    const f: ConfirmedFields = { ...R2, commitment: 18_000_000, unfundedCommitment: 0 }
    const s = buildSchedule(f, BAT)
    const liq = buildLiquidityView(s, f)
    for (const p of s.periods) expect(p.call).toBe(0)
    expect(liq.peakFundingNeed).toBeNull() // surfaced as $0 forward need
    // Recompute: with no future calls the economics reduce to the 18M/31.2M case —
    // entitlement 13,621,513.82, catch-up completes, carry 0.2 × 17.4M = 3.48M,
    // future LP-net 27.72M (matches the report's figures).
    expect(gpCarryOf({ breakdown: s.distributionBreakdown })).toBeCloseTo(3_480_000, 0)
    expect(s.futureLpNet).toBeCloseTo(27_720_000, 0)
  })

  it('case 4 — hurdle 0%: first dollar above ROC enters carry mechanics', () => {
    // Recompute: entitlement 0 → no pref tier, no catch-up; residual 20.2M splits
    // 80/20 → gpCarry = 4.04M, lifetime LP-net 41.16M (matches the report — the
    // convention change is inert when there is no preferred to credit).
    const f: ConfirmedFields = { ...R2, fundTerms: { ...R2.fundTerms, hurdleRate: 0 } }
    const d = distOf(f, BAT)
    expect(d.preferredEntitlement).toBe(0)
    expect(gpCarryOf(d)).toBeCloseTo(4_040_000, 1)
    expect(d.lifetimeLpNet).toBeCloseTo(41_160_000, 1)
  })

  it('case 5 — carry 0%: LP-net future distributions equal projected gross', () => {
    const f: ConfirmedFields = { ...R2, fundTerms: { ...R2.fundTerms, carryRate: 0 } }
    const d = distOf(f, BAT)
    expect(gpCarryOf(d)).toBe(0)
    expect(d.lifetimeLpNet).toBeCloseTo(45_200_000, 2)
    expect(d.futureLpNet).toBeCloseTo(41_000_000, 2)
    expect(sum(d.periods.map(p => p.amount))).toBeCloseTo(41_000_000, 1)
  })

  it('case 6 — IP end 2026-06-01: exactly one nonzero forward call of $7M, both modes', () => {
    const f: ConfirmedFields = { ...R2, investmentPeriodEndDate: '2026-06-01' }
    for (const curve of ['front-loaded', 'history-fit'] as const) {
      const calls = projectCalls(f, { ...BAT, callCurve: curve })
      const nonzero = calls.filter(c => c.amount > 1e-6)
      expect(nonzero).toHaveLength(1)
      expect(nonzero[0].amount).toBeCloseTo(7_000_000, 2)
      expect(nonzero[0].date).toBe('2026-06-30')
    }
    // PFN recomputed under 1.2.0: 7M call less the first-quarter LP-net distribution
    // (30,572.42 of the 37,706,268.58 future total) = 6,969,427.58. The report's
    // 6,970,032.66 was derived from the old-convention distribution level.
    const s = buildSchedule(f, BAT)
    const liq = buildLiquidityView(s, f)
    expect(liq.peakFundingNeed!.value).toBeCloseTo(6_969_427.58, 1)
    expect(liq.peakFundingNeed!.value).toBeLessThanOrEqual(7_000_000)
  })

  it('case 7 — hold 1y vs 8y: peak index moves 4 → 16', () => {
    const peakIdx = (hold: number) => {
      const amounts = distOf(R2, { ...BAT, avgRemainingHoldYears: hold }).periods.map(p => p.amount)
      return amounts.indexOf(Math.max(...amounts))
    }
    expect(peakIdx(1)).toBe(4)   // 2027-06-30
    expect(peakIdx(8)).toBe(16)  // capped at 2030-06-30
  })

  it('case 8 — hold 12y: peak stays at the cap, final quarter zero, sum preserved', () => {
    const d = distOf(R2, { ...BAT, avgRemainingHoldYears: 12 })
    const amounts = d.periods.map(p => p.amount)
    expect(amounts.indexOf(Math.max(...amounts))).toBe(16)
    expect(d.holdCapped).toBe(true)
    expect(amounts.at(-1)!).toBeCloseTo(0, 6)
    // Sum preserved = the full future LP-net releases (37,333,347.25 under 1.2.0).
    expect(sum(amounts)).toBeCloseTo(d.futureLpNet, 2)
    expect(d.futureLpNet).toBeCloseTo(37_333_347.25, 1)
  })

  it('case 9 — NAV $0, call multiple 0: no distributions, PFN equals unfunded, no crossover', () => {
    const f: ConfirmedFields = { ...R2, currentNav: 0 }
    const s = buildSchedule(f, { ...BAT, forwardCallMultiple: 0 })
    const liq = buildLiquidityView(s, f)
    for (const p of s.periods) expect(p.distribution).toBe(0)
    expect(s.futureLpNet).toBe(0)
    expect(liq.peakFundingNeed!.value).toBeCloseTo(7_000_000, 2)
    expect(s.crossover).toBeNull()
  })

  it('case 10 — NAV multiple 1.3765679416×: preferred absorbs all profit, GP gets nothing', () => {
    // gross = 4.2M + 19.5M × 1.3765679416 + 9.8M = 40,843,074.86; profit above ROC =
    // 15,843,074.86. The report seeded this so the OLD convention's catch-up landed
    // exactly funded with residual ≈ 0 (GP = catch-up only, 3,168,614.97). Under
    // ROC-first the entitlement is 16,533,347.25 > profit, so the preferred tier caps
    // at the profit itself, the catch-up never starts, and the GP receives $0 —
    // the recomputed detecting outcome for this seed.
    const d = distOf(R2, { ...BAT, forwardValueMultiple: 1.3765679416 })
    expect(d.breakdown.preferredReturn).toBeCloseTo(15_843_074.86, 1)
    expect(d.breakdown.gpCatchUp).toBe(0)
    expect(gpCarryOf(d)).toBe(0)
    expect(d.lifetimeLpNet).toBeCloseTo(40_843_074.86, 1)
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
