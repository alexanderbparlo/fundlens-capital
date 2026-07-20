'use client'
import { useState } from 'react'
import { formatCurrency } from '@/lib/utils'
import { holdCapInfo } from '@/lib/capital/distributionPacing'

function Segmented({ value, options, onChange }) {
  return (
    <div className="inline-flex rounded-card border border-border-subtle overflow-hidden">
      {options.map(o => (
        <button
          key={o.value}
          disabled={o.disabled}
          onClick={() => onChange(o.value)}
          className={[
            'px-4 py-2 font-mono text-data-sm transition-colors',
            value === o.value ? 'bg-accent text-surface-950 font-medium' : 'text-text-secondary hover:text-text-primary',
            o.disabled ? 'opacity-30 cursor-not-allowed' : '',
          ].join(' ')}
          title={o.title}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

function NumberField({ label, hint, value, onChange, step = 0.1, min, max, suffix }) {
  return (
    <div>
      <label className="block font-body text-data-sm text-text-secondary mb-1.5">{label}</label>
      <div className="relative max-w-[180px]">
        <input
          type="number"
          step={step}
          min={min}
          max={max}
          value={value}
          onChange={e => onChange(e.target.value === '' ? '' : Number(e.target.value))}
          className="w-full bg-surface-950 border border-border-subtle rounded-chip px-3 py-2 font-mono text-data-sm text-text-primary focus:outline-none focus:border-accent-border transition-colors"
        />
        {suffix && <span className="absolute right-3 top-1/2 -translate-y-1/2 font-mono text-data-sm text-text-muted">{suffix}</span>}
      </div>
      {hint && <p className="font-body text-data-sm text-text-muted mt-1.5 max-w-[44ch]">{hint}</p>}
    </div>
  )
}

export function PacingConfig({ fields, initialConfig, onRun, onBack }) {
  const [config, setConfig] = useState(initialConfig)
  const hasHistory = (fields?.historicalCalls?.length ?? 0) > 0
  const navGross = Math.max(0, fields?.currentNav ?? 0) * (Number(config.forwardValueMultiple) || 0)
  const calledGross = Math.max(0, fields?.unfundedCommitment ?? 0) * (Number(config.forwardCallMultiple) || 0)
  const projectedGross = navGross + calledGross

  // The J-curve peak is capped at ~80% of the remaining fund life so a wind-down taper
  // always remains. Beyond that the hold input stops moving the peak — say so instead
  // of saturating silently (round 3, Item 3). Same formula the engine reports as
  // `holdCapped` on the built schedule.
  const holdCap = fields?.asOfDate
    ? holdCapInfo(fields.asOfDate, fields.fundEndDate ?? null, Number(config.avgRemainingHoldYears) || 0)
    : null

  const set = (key, value) => setConfig(prev => ({ ...prev, [key]: value }))

  return (
    <div className="w-full max-w-confirm mx-auto">
      <p className="font-mono text-label uppercase tracking-widest text-accent mb-3">Pacing</p>
      <h2 className="font-display font-semibold text-xl text-text-primary mb-2">Set the projection assumptions</h2>
      <p className="font-body text-sm text-text-secondary leading-relaxed mb-8 max-w-[60ch]">
        These are starting points. Every projected quarter is editable on the results grid once the schedule is built.
      </p>

      <div className="space-y-9">
        <div>
          <h3 className="font-mono text-label uppercase tracking-widest text-text-label mb-3">Call pacing</h3>
          <Segmented
            value={config.callCurve}
            onChange={v => set('callCurve', v)}
            options={[
              { value: 'front-loaded', label: 'Front-loaded' },
              { value: 'history-fit', label: 'History-fit', disabled: !hasHistory, title: hasHistory ? '' : 'No historical call data found in the upload' },
            ]}
          />
          <p className="font-body text-data-sm text-text-muted mt-3 max-w-[56ch]">
            {config.callCurve === 'front-loaded'
              ? 'Remaining unfunded clusters early in the investment period and tapers.'
              : 'Projects forward at the observed historical deployment pace.'}
          </p>
          {config.callCurve === 'front-loaded' && (
            <div className="mt-5">
              <NumberField
                label="Front-load intensity"
                hint="Lower = more front-loaded. 1.0 spreads calls evenly across remaining quarters."
                value={config.callDecay}
                onChange={v => set('callDecay', v)}
                step={0.05}
                min={0.3}
                max={1}
              />
            </div>
          )}
        </div>

        <div className="accent-line" />

        <div>
          <h3 className="font-mono text-label uppercase tracking-widest text-text-label mb-4">Distribution pacing</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
            <NumberField
              label="Forward value multiple on NAV"
              hint="Total value the remaining NAV is assumed to ultimately return."
              value={config.forwardValueMultiple}
              onChange={v => set('forwardValueMultiple', v)}
              step={0.1}
              min={0}
              suffix="x"
            />
            <NumberField
              label="Forward multiple on called capital"
              hint="Total value the future-called (unfunded) capital returns. Defaulted below the NAV multiple — late-deployed capital has less time to mature. Set to 0 to exclude future calls from the distribution base."
              value={config.forwardCallMultiple}
              onChange={v => set('forwardCallMultiple', v)}
              step={0.1}
              min={0}
              suffix="x"
            />
            <NumberField
              label="Avg remaining hold"
              hint="Positions the J-curve peak — when exits are assumed to cluster, then taper toward fund end."
              value={config.avgRemainingHoldYears}
              onChange={v => set('avgRemainingHoldYears', v)}
              step={0.5}
              min={0}
              suffix="yrs"
            />
          </div>
          {holdCap?.capped && (
            <p className="font-body text-data-sm text-data-flag mt-3 max-w-[56ch]">
              Hold capped at ~{holdCap.maxHoldYears} years by remaining fund life — the distribution
              peak stays inside the wind-down taper, so longer holds no longer move it.
            </p>
          )}
          <div className="card px-4 py-3 mt-5 inline-flex items-baseline gap-2">
            <span className="font-body text-data-sm text-text-muted">Projected gross:</span>
            <span className="data-value text-data-sm text-text-primary">{formatCurrency(projectedGross, fields?.currency)}</span>
            <span className="font-body text-data-sm text-text-muted">
              NAV {formatCurrency(navGross, fields?.currency)} + called {formatCurrency(calledGross, fields?.currency)}
            </span>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between mt-10">
        <button onClick={onBack} className="font-body text-sm text-text-muted hover:text-text-secondary transition-colors">← Back</button>
        <button
          onClick={() => onRun(config)}
          className="px-6 py-3 rounded-card font-mono text-sm tracking-wide bg-accent text-surface-950 font-medium hover:bg-accent-dim transition-colors"
        >
          Build Projection
        </button>
      </div>
    </div>
  )
}
