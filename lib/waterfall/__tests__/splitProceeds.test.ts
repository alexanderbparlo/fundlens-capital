import { describe, it, expect } from 'vitest'
import { splitProceeds, preferredReturnAmount, type WaterfallTerms } from '../splitProceeds'

const base: WaterfallTerms = {
  hurdleRate: 0.08,
  carryRate: 0.2,
  catchUp: 'full',
  preferredCompounding: 'simple',
  paidIn: 10_000_000,
  prefYears: 5,
}

describe('splitProceeds — European whole-fund waterfall', () => {
  it('splits all four tiers with a self-consistent 100% catch-up', () => {
    // Hand-computed: paidIn 10M, simple pref 8% × 5y = 4M, gross 20M, carry 20%.
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

  it('compounds the preferred return when configured', () => {
    // 10M × (1.08^5 − 1) = 10M × 0.469328 = 4,693,280.76
    const pref = preferredReturnAmount({ ...base, preferredCompounding: 'compound' })
    expect(pref).toBeCloseTo(4_693_280.76, 1)
  })
})
