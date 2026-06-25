import { describe, it, expect } from 'vitest'
import { requiredFieldGaps } from '../readiness.js'

const complete = {
  asOfDate: '2026-06-30',
  investmentPeriodEndDate: '2026-12-31',
  fundEndDate: '2031-12-31',
  commitment: 10_000_000,
  calledToDate: 6_000_000,
  unfundedCommitment: 4_000_000,
  distributionsToDate: 2_000_000,
  currentNav: 7_000_000,
  fundTerms: { hurdleRate: 0.08, carryRate: 0.2 },
}

describe('requiredFieldGaps', () => {
  it('returns no gaps when all required fields are present', () => {
    expect(requiredFieldGaps(complete)).toEqual([])
  })

  it('accepts a fund-end date alone as the forward horizon', () => {
    expect(requiredFieldGaps({ ...complete, investmentPeriodEndDate: null })).toEqual([])
  })

  it('flags a missing forward horizon when both dates are absent', () => {
    const gaps = requiredFieldGaps({ ...complete, investmentPeriodEndDate: null, fundEndDate: null })
    expect(gaps).toContain('Investment-period-end or fund-end date')
  })

  it('flags missing numeric fields and rates', () => {
    const gaps = requiredFieldGaps({ ...complete, currentNav: null, fundTerms: { hurdleRate: null, carryRate: 0.2 } })
    expect(gaps).toContain('Current NAV')
    expect(gaps).toContain('Hurdle rate')
    expect(gaps).not.toContain('Carried interest')
  })

  it('treats a null fields object as entirely incomplete', () => {
    expect(requiredFieldGaps(null)).toEqual(['All fields'])
  })
})
