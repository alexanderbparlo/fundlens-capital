// Shared types for the FundLens Capital deterministic pacing engine.
// Every module under lib/capital/ and lib/waterfall/ is pure and framework-free —
// no React, no Next, no Anthropic. The engine never calls a model.

export type Currency = 'USD' | 'EUR' | 'GBP'

// A dated cash flow, amount as a positive magnitude. Direction (in/out) is implied
// by which series it belongs to.
export interface DatedCashFlow {
  date: string   // ISO 'YYYY-MM-DD'
  amount: number // >= 0
}

// Fund-level economics used by the waterfall to split projected gross proceeds
// into LP-net distributions and GP carry.
export interface FundTerms {
  hurdleRate: number                          // decimal, e.g. 0.08
  carryRate: number                           // decimal, e.g. 0.20
  catchUp: 'full' | 'none'                    // 100% GP catch-up, or none
  preferredCompounding: 'compound' | 'simple' // how the preferred return accrues
}

// The QC-gated inputs. Everything downstream is computed from this object only.
export interface ConfirmedFields {
  fundName: string | null
  currency: Currency
  asOfDate: string                       // reporting / as-of date (ISO)
  vintageDate: string | null             // fund inception / vintage
  investmentPeriodEndDate: string | null // drives call-pacing horizon
  fundEndDate: string | null             // drives distribution-pacing horizon

  commitment: number          // LP total committed capital
  calledToDate: number        // cumulative capital called from this LP (ITD)
  unfundedCommitment: number  // commitment - called (remaining callable)
  distributionsToDate: number // cumulative distributions to this LP (ITD)
  currentNav: number          // this LP's share of fund NAV

  fundTerms: FundTerms

  historicalCalls: DatedCashFlow[]
  historicalDistributions: DatedCashFlow[]

  // ── Reserved, NOT implemented (v1 known exclusions — see README "Known
  // exclusions (v1)"). Each of these silently breaks the plain-vanilla pacing
  // mechanics: recycling makes uncalled ≠ commitment − called; subscription lines
  // shift observed call timing off the true deployment pace; NAV facilities
  // manufacture non-exit distributions. Reserved so a later version can detect
  // and reject (or model) them — no engine code reads these yet.
  recyclingProvision?: boolean
  subscriptionLineInUse?: boolean
  navFacilityInUse?: boolean
}

// User-tunable pacing assumptions. Defaults are starting points; every value is
// overridable, and individual periods can be overridden outright (PeriodOverride).
export interface PacingConfig {
  callCurve: 'front-loaded' | 'history-fit'
  callDecay: number                // geometric decay for front-loaded weights (0,1], default 0.7
  forwardValueMultiple: number     // total-value multiple on current NAV for remaining holdings
  forwardCallMultiple: number      // total-value multiple on future-called (unfunded) capital; 0 = NAV-only
  avgRemainingHoldYears: number    // avg years until remaining holdings exit — positions the J-curve peak
  overrides: PeriodOverride[]
}

// Replaces a projected period's call and/or distribution with a known figure.
export interface PeriodOverride {
  date: string                 // quarter-end ISO, matches a projected period
  call?: number | null         // override projected call magnitude (cash out)
  distribution?: number | null // override projected distribution magnitude (cash in)
}

// One quarter of the projected schedule — the source-of-truth grid row.
export interface ProjectedPeriod {
  date: string                  // quarter-end ISO
  label: string                 // "Q3 2026"
  call: number                  // projected call magnitude (>= 0), cash OUT for the LP
  distribution: number          // projected distribution magnitude (>= 0), cash IN
  netCashFlow: number           // distribution - call
  cumulativeCalled: number      // running, opens at calledToDate
  cumulativeDistributed: number // running, opens at distributionsToDate
  cumulativeNet: number         // running net position, opens at distributionsToDate - calledToDate
  callOverridden: boolean
  distributionOverridden: boolean
}

export interface WaterfallBreakdown {
  returnOfCapital: number
  preferredReturn: number
  gpCatchUp: number
  lpProfitSplit: number
  gpProfitSplit: number
}

export interface WaterfallResult {
  lpNet: number    // total the LP receives, net of carry
  gpCarry: number  // total carry to the GP
  breakdown: WaterfallBreakdown
}

export interface CapitalSchedule {
  asOfDate: string
  engineVersion: string
  periods: ProjectedPeriod[]

  openingCumulativeCalled: number      // = calledToDate
  openingCumulativeDistributed: number // = distributionsToDate
  openingCumulativeNet: number         // = distributionsToDate - calledToDate

  totalProjectedCalls: number
  totalProjectedDistributions: number

  trough: { date: string; value: number } | null     // most negative cumulative net position
  crossover: { date: string } | null                 // first quarter the LP turns net-positive

  lifetimeLpNet: number          // LP lifetime distributions net of carry (ITD + projected)
  futureLpNet: number            // projected future net-of-carry distributions
  distributionBreakdown: WaterfallBreakdown
}

export interface LiquidityPeriod {
  date: string
  label: string
  call: number            // liquidity needed this quarter
  runningUnfunded: number // remaining unfunded commitment after this call
  distribution: number    // liquidity returned this quarter
  netLiquidity: number    // distribution - call
}

export interface RollingLiquidity {
  quarters: number // window length
  amount: number   // total projected calls over the next `quarters` quarters
}

export interface LiquidityView {
  openingUnfunded: number
  periods: LiquidityPeriod[]
  rollingLiquidityRequired: RollingLiquidity[]
  peakFundingNeed: { date: string; value: number } | null // most negative cumulative net, as a positive figure
}
