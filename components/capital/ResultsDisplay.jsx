'use client'
import { useState } from 'react'
import { Link2, Check } from 'lucide-react'
import { formatCurrency } from '@/lib/utils'
import { JCurveChart } from './JCurveChart'
import { ScheduleGrid } from './ScheduleGrid'
import { LiquidityView } from './LiquidityView'
import { ExportButton } from './ExportButton'
import { NarrativePanel } from './NarrativePanel'

function quarterOf(date) {
  if (!date) return '—'
  const d = new Date(date)
  return `Q${Math.floor(d.getUTCMonth() / 3) + 1} ${d.getUTCFullYear()}`
}

function Metric({ label, value, sub, tone }) {
  return (
    <div className="card px-4 py-3">
      <p className="font-mono text-label uppercase tracking-widest text-text-label mb-1.5">{label}</p>
      <p className={`data-value text-data-xl ${tone ?? 'text-text-primary'}`}>{value}</p>
      {sub && <p className="font-body text-data-sm text-text-muted mt-0.5">{sub}</p>}
    </div>
  )
}

function ShareButton({ runId }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/capital?run=${runId}`)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      /* clipboard unavailable — no-op */
    }
  }
  return (
    <button
      onClick={copy}
      className="flex items-center gap-1.5 px-3 py-2 rounded-card border border-border-subtle font-mono text-data-sm text-text-secondary hover:text-text-primary hover:border-accent-border transition-colors"
    >
      {copied ? <><Check size={13} className="text-data-positive" /> Copied</> : <><Link2 size={13} /> Share link</>}
    </button>
  )
}

export function ResultsDisplay({ fields, schedule, liquidity, narrative, isGeneratingNarrative, runId, onOverride, onBack, onReset }) {
  const currency = fields?.currency ?? 'USD'

  return (
    <div className="w-full max-w-results mx-auto">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4 mb-6">
        <div>
          <p className="font-mono text-label uppercase tracking-widest text-accent mb-2">Results</p>
          <h2 className="font-display font-semibold text-2xl text-text-primary">{fields?.fundName || 'Capital cash-flow forecast'}</h2>
          <p className="font-body text-sm text-text-muted mt-1">As of {fields?.asOfDate || '—'}</p>
        </div>
        <div className="flex items-center gap-2">
          {runId && <ShareButton runId={runId} />}
          <ExportButton schedule={schedule} fundName={fields?.fundName} />
        </div>
      </div>

      {/* Key metrics */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        <Metric
          label="Peak funding need"
          value={liquidity.peakFundingNeed ? formatCurrency(liquidity.peakFundingNeed.value, currency) : '—'}
          sub={liquidity.peakFundingNeed ? quarterOf(liquidity.peakFundingNeed.date) : 'never net-negative'}
          tone="text-data-flag"
        />
        <Metric label="J-curve crossover" value={schedule.crossover ? quarterOf(schedule.crossover.date) : '—'} sub={schedule.crossover ? 'turns net-positive' : 'not within fund life'} tone="text-data-positive" />
        <Metric label="Projected calls" value={formatCurrency(schedule.totalProjectedCalls, currency)} sub="remaining unfunded" tone="text-data-negative" />
        <Metric label="Projected distributions" value={formatCurrency(schedule.totalProjectedDistributions, currency)} sub="net of carry" tone="text-data-positive" />
      </div>

      <div className="space-y-6">
        <JCurveChart schedule={schedule} currency={currency} />
        <LiquidityView liquidity={liquidity} currency={currency} />
        <ScheduleGrid schedule={schedule} currency={currency} onOverride={onOverride} />
        <NarrativePanel narrative={narrative} isGenerating={isGeneratingNarrative} />
      </div>

      {/* Scope banner — persistent, non-dismissible */}
      <div className="scope-banner px-4 py-3 mt-6 flex items-start gap-2">
        <span className="indicator-dot indicator-missing mt-1.5" />
        <p className="font-body text-data-sm text-text-secondary leading-relaxed max-w-[80ch]">
          Single-fund, single-LP projection on the stated pacing assumptions. Distributions are projected net of GP carried
          interest via a whole-fund (European) waterfall. This is not investment advice; figures are estimates that depend on
          the assumptions shown. Multi-fund aggregation, scenario branching, and tax-character modeling are planned for v2.
        </p>
      </div>

      <div className="flex items-center justify-between mt-8">
        <button onClick={onBack} className="font-body text-sm text-text-muted hover:text-text-secondary transition-colors">← Adjust pacing</button>
        <button onClick={onReset} className="font-body text-sm text-text-muted hover:text-text-secondary transition-colors">Start new forecast</button>
      </div>
    </div>
  )
}
