'use client'
import { useState } from 'react'
import { requiredFieldGaps } from '@/lib/capital/readiness'

// Field metadata. `path` indexes into the engine ConfirmedFields object; `source`
// is the matching fieldSources key.
const GROUPS = [
  {
    title: 'Fund',
    fields: [
      { path: ['fundName'], source: 'fund.fundName', label: 'Fund name', type: 'text' },
      { path: ['currency'], source: 'fund.currency', label: 'Currency', type: 'select', options: ['USD', 'EUR', 'GBP'] },
      { path: ['asOfDate'], source: 'fund.asOfDate', label: 'As-of date', type: 'date' },
      { path: ['vintageDate'], source: 'fund.vintageDate', label: 'Vintage / inception', type: 'date' },
      { path: ['investmentPeriodEndDate'], source: 'fund.investmentPeriodEndDate', label: 'Investment period end', type: 'date' },
      { path: ['fundEndDate'], source: 'fund.fundEndDate', label: 'Fund end date', type: 'date' },
    ],
  },
  {
    title: 'LP capital account',
    fields: [
      { path: ['commitment'], source: 'fund.commitment', label: 'Commitment', type: 'currency' },
      { path: ['calledToDate'], source: 'fund.calledToDate', label: 'Called to date', type: 'currency' },
      { path: ['unfundedCommitment'], source: 'fund.unfundedCommitment', label: 'Unfunded (RCC)', type: 'currency' },
      { path: ['distributionsToDate'], source: 'fund.distributionsToDate', label: 'Distributions to date', type: 'currency' },
      { path: ['currentNav'], source: 'fund.currentNav', label: 'Current NAV', type: 'currency' },
    ],
  },
  {
    title: 'Fund terms',
    fields: [
      { path: ['fundTerms', 'hurdleRate'], source: 'terms.hurdleRate', label: 'Hurdle rate', type: 'percent' },
      { path: ['fundTerms', 'carryRate'], source: 'terms.carryRate', label: 'Carried interest', type: 'percent' },
      { path: ['fundTerms', 'catchUp'], source: 'terms.catchUp', label: 'GP catch-up', type: 'select', options: ['full', 'none'] },
      { path: ['fundTerms', 'preferredCompounding'], source: 'terms.preferredCompounding', label: 'Pref compounding', type: 'select', options: ['compound', 'simple'] },
    ],
  },
]

const SOURCE_DOT = {
  extracted: { cls: 'indicator-extracted', label: 'extracted' },
  derived: { cls: 'indicator-derived', label: 'derived' },
  manual: { cls: 'indicator-manual', label: 'edited' },
  missing: { cls: 'indicator-missing', label: 'add' },
}

function getAt(obj, path) {
  return path.reduce((o, k) => (o == null ? undefined : o[k]), obj)
}
function setAt(obj, path, value) {
  const next = structuredClone(obj)
  let cur = next
  for (let i = 0; i < path.length - 1; i++) cur = cur[path[i]]
  cur[path[path.length - 1]] = value
  return next
}

export function ConfirmFields({ extracted, initialFields, onConfirm, onBack }) {
  const [fields, setFields] = useState(initialFields)
  const [sources, setSources] = useState(extracted?.fieldSources ?? {})
  const gaps = requiredFieldGaps(fields)

  const update = (field, raw) => {
    let value = raw
    if (field.type === 'currency') value = raw === '' ? null : Number(raw)
    else if (field.type === 'percent') value = raw === '' ? null : Number(raw) / 100
    else if (raw === '') value = null
    setFields(prev => setAt(prev, field.path, value))
    setSources(prev => ({ ...prev, [field.source]: 'manual' }))
  }

  const renderInput = field => {
    const value = getAt(fields, field.path)
    const baseCls =
      'w-full bg-surface-950 border border-border-subtle rounded-chip px-3 py-2 text-data-sm text-text-primary ' +
      'focus:outline-none focus:border-accent-border transition-colors'

    if (field.type === 'select') {
      return (
        <select className={`${baseCls} font-body`} value={value ?? ''} onChange={e => update(field, e.target.value)}>
          <option value="">—</option>
          {field.options.map(o => <option key={o} value={o}>{o}</option>)}
        </select>
      )
    }
    if (field.type === 'date') {
      return <input type="date" className={`${baseCls} font-mono`} value={value ?? ''} onChange={e => update(field, e.target.value)} />
    }
    if (field.type === 'text') {
      return <input type="text" className={`${baseCls} font-body`} value={value ?? ''} onChange={e => update(field, e.target.value)} />
    }
    const display = field.type === 'percent' ? (value == null ? '' : value * 100) : (value ?? '')
    return (
      <div className="relative">
        <input
          type="number"
          inputMode="decimal"
          className={`${baseCls} font-mono ${field.type === 'currency' ? 'pl-6' : 'pr-7'}`}
          value={display}
          onChange={e => update(field, e.target.value)}
        />
        {field.type === 'currency' && <span className="absolute left-3 top-1/2 -translate-y-1/2 font-mono text-data-sm text-text-muted">$</span>}
        {field.type === 'percent' && <span className="absolute right-3 top-1/2 -translate-y-1/2 font-mono text-data-sm text-text-muted">%</span>}
      </div>
    )
  }

  return (
    <div className="w-full max-w-confirm mx-auto">
      <p className="font-mono text-label uppercase tracking-widest text-accent mb-3">Confirm</p>
      <h2 className="font-display font-semibold text-xl text-text-primary mb-2">Review the extracted figures</h2>
      <p className="font-body text-sm text-text-secondary leading-relaxed mb-2 max-w-[60ch]">
        Correct anything the model misread and fill any gaps. Projections run only on what you confirm here.
      </p>
      <div className="flex items-center gap-4 mb-8 text-data-sm font-body text-text-muted">
        <span className="flex items-center gap-1.5"><span className="indicator-dot indicator-extracted" /> extracted</span>
        <span className="flex items-center gap-1.5"><span className="indicator-dot indicator-derived" /> derived</span>
        <span className="flex items-center gap-1.5"><span className="indicator-dot indicator-missing" /> needs input</span>
      </div>

      {extracted?.extractionNotes ? (
        <div className="card px-4 py-3 mb-8">
          <p className="font-mono text-label uppercase tracking-widest text-text-label mb-1">Extraction notes</p>
          <p className="font-body text-data-sm text-text-secondary leading-relaxed">{extracted.extractionNotes}</p>
        </div>
      ) : null}

      <div className="space-y-8">
        {GROUPS.map(group => (
          <div key={group.title}>
            <h3 className="font-mono text-label uppercase tracking-widest text-text-label mb-3 pb-2 border-b border-border-subtle">
              {group.title}
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4">
              {group.fields.map(field => {
                const source = sources[field.source] ?? 'missing'
                const dot = SOURCE_DOT[source] ?? SOURCE_DOT.missing
                return (
                  <div key={field.source}>
                    <label className="flex items-center gap-1.5 mb-1.5">
                      <span className={`indicator-dot ${dot.cls}`} title={dot.label} />
                      <span className="font-body text-data-sm text-text-secondary">{field.label}</span>
                    </label>
                    {renderInput(field)}
                  </div>
                )
              })}
            </div>
          </div>
        ))}
      </div>

      {gaps.length > 0 && (
        <div className="scope-banner px-4 py-3 mt-8 flex items-start gap-2">
          <span className="indicator-dot indicator-missing mt-1.5" />
          <p className="font-body text-data-sm text-text-secondary leading-relaxed">
            Add these required fields before projecting: <span className="text-text-primary">{gaps.join(', ')}</span>.
          </p>
        </div>
      )}

      <div className="flex items-center justify-between mt-10">
        <button onClick={onBack} className="font-body text-sm text-text-muted hover:text-text-secondary transition-colors">← Back</button>
        <button
          onClick={() => onConfirm(fields)}
          disabled={gaps.length > 0}
          className="px-6 py-3 rounded-card font-mono text-sm tracking-wide bg-accent text-surface-950 font-medium hover:bg-accent-dim transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Confirm & Set Pacing
        </button>
      </div>
    </div>
  )
}
