import { describe, it, expect } from 'vitest'
import {
  splitProceeds,
  preferredReturnOutstanding,
  type WaterfallTerms,
} from '../splitProceeds'

const base: WaterfallTerms = {
  hurdleRate: 0.08,
  carryRate: 0.2,
  catchUp: 'full',
  preferredCompounding: 'compound',
  paidIn: 10_000_000,
  preferredOwed: 4_000_000, // hand-set for the tier-split fixtures below
}

describe('splitProceeds — European whole-fund waterfall', () => {
  it('splits all four tiers with a self-consistent 100% catch-up', () => {
    // Hand-computed: paidIn 10M, preferred 4M, gross 20M, carry 20%.
    //   ROC      = 10M            (remaining 10M)
    //   Pref     = 4M             (remaining 6M)
    //   CatchUp  = 4M × .2/.8 = 1M (remaining 5M)
    //   Carry    = 5M → LP 4M / GP 1M
    //   lpNet = 10 + 4 + 4 = 18M ; gpCarry = 1 + 1 = 2M
    const r = splitProceeds(20_000_000, base)

    expect(r.breakdown.returnOfCapital).toBeCloseTo(10_000_000, 2)
    expect(r.breakdown.preferredReturn).toBeCloseTo(4_000_000, 2)
    expect(r.breakdown.gpCatchUp).toBeCloseTo(1_000_000, 2)
    expect(r.breakdown.lpProfitSplit).toBeCloseTo(4_000_000, 2)
    expect(r.breakdown.gpProfitSplit).toBeCloseTo(1_000_000, 2)
    expect(r.lpNet).toBeCloseTo(18_000_000, 2)
    expect(r.gpCarry).toBeCloseTo(2_000_000, 2)
  })

  it('the GP ends with exactly carry% of total profit above ROC', () => {
    const r = splitProceeds(20_000_000, base)
    const totalProfit = 20_000_000 - base.paidIn
    expect(r.gpCarry / totalProfit).toBeCloseTo(base.carryRate, 6)
  })

  it('returns capital only when proceeds are below paid-in (LP underwater)', () => {
    const r = splitProceeds(7_000_000, base)
    expect(r.breakdown.returnOfCapital).toBeCloseTo(7_000_000, 2)
    expect(r.breakdown.preferredReturn).toBe(0)
    expect(r.gpCarry).toBe(0)
    expect(r.lpNet).toBeCloseTo(7_000_000, 2)
  })

  it('pays no carry when proceeds clear capital but not full preferred', () => {
    const r = splitProceeds(12_000_000, base) // 10M ROC + 2M of the 4M pref
    expect(r.breakdown.preferredReturn).toBeCloseTo(2_000_000, 2)
    expect(r.breakdown.gpCatchUp).toBe(0)
    expect(r.gpCarry).toBe(0)
    expect(r.lpNet).toBeCloseTo(12_000_000, 2)
  })

  it('skips the catch-up tier when catchUp is none', () => {
    const r = splitProceeds(20_000_000, { ...base, catchUp: 'none' })
    expect(r.breakdown.gpCatchUp).toBe(0)
    // ROC 10M, pref 4M, residual 6M → LP 4.8M / GP 1.2M
    expect(r.breakdown.lpProfitSplit).toBeCloseTo(4_800_000, 2)
    expect(r.breakdown.gpProfitSplit).toBeCloseTo(1_200_000, 2)
    expect(r.gpCarry).toBeCloseTo(1_200_000, 2)
  })

  it('routes all profit to the LP when carry is zero', () => {
    const r = splitProceeds(20_000_000, { ...base, carryRate: 0 })
    expect(r.gpCarry).toBe(0)
    expect(r.lpNet).toBeCloseTo(20_000_000, 2)
  })
})

describe('preferredReturnOutstanding — outstanding-capital accrual', () => {
  it('compounds the hurdle on a single contribution held to the horizon', () => {
    // 10M contributed at t0, no distributions, compounded 8% to the horizon.
    // yearsBetween uses 365.25-day years, so 2021-01-01 → 2026-01-01 is 4.998y:
    // 10M × (1.08^4.998 − 1) = 4,692,506.79
    const pref = preferredReturnOutstanding(
      [{ date: '2021-01-01', amount: 10_000_000 }],
      0.08,
      'compound',
      '2021-01-01',
      '2026-01-01'
    )
    expect(pref).toBeCloseTo(4_692_506.79, 0)
  })

  it('credits distributions against outstanding capital, lowering accrued preferred', () => {
    // Same 10M, but a 5M distribution at year 2.5 returns capital, so the back half
    // accrues on a smaller base → less preferred than the no-distribution case.
    const withDist = preferredReturnOutstanding(
      [
        { date: '2021-01-01', amount: 10_000_000 },
        { date: '2023-07-01', amount: -5_000_000 },
      ],
      0.08,
      'compound',
      '2021-01-01',
      '2026-01-01'
    )
    expect(withDist).toBeGreaterThan(0)
    expect(withDist).toBeLessThan(4_693_280.76)
  })

  it('accrues simple interest on unreturned capital only', () => {
    // Simple 8% on 10M for 4.998y = 3,999,452, unaffected by interest-on-interest.
    const pref = preferredReturnOutstanding(
      [{ date: '2021-01-01', amount: 10_000_000 }],
      0.08,
      'simple',
      '2021-01-01',
      '2026-01-01'
    )
    expect(pref).toBeCloseTo(3_999_452.43, 0)
  })

  it('returns zero when the hurdle is zero', () => {
    const pref = preferredReturnOutstanding(
      [{ date: '2021-01-01', amount: 10_000_000 }],
      0,
      'compound',
      '2021-01-01',
      '2026-01-01'
    )
    expect(pref).toBe(0)
  })
})
