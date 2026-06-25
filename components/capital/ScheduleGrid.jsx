'use client'
import { useState } from 'react'
import { formatCurrency } from '@/lib/utils'
import { RotateCcw } from 'lucide-react'

// Editable cell: shows the projected magnitude; on focus becomes a number input that
// writes a per-period override. Clearing it restores the projected default.
function OverrideCell({ value, overridden, onCommit, tone }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')

  const start = () => { setDraft(value ? String(Math.round(value)) : ''); setEditing(true) }
  const commit = () => {
    setEditing(false)
    const next = draft.trim() === '' ? null : Number(draft)
    if (next !== null && Number.isNaN(next)) return
    onCommit(next)
  }

  if (editing) {
    return (
      <input
        autoFocus
        type="number"
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') setEditing(false) }}
        className="w-full bg-surface-950 border border-accent-border rounded-chip px-2 py-1 font-mono text-data-sm text-right text-text-primary focus:outline-none"
      />
    )
  }

  return (
    <button
      onClick={start}
      className={[
        'w-full text-right font-mono text-data-sm px-2 py-1 rounded-chip hover:bg-surface-800 transition-colors',
        overridden ? 'text-data-flag' : tone,
      ].join(' ')}
      title={overridden ? 'Overridden — click to edit, clear to restore projection' : 'Click to override'}
    >
      {value ? formatCurrency(value) : '—'}
      {overridden && <span className="indicator-dot indicator-missing ml-1.5 align-middle" />}
    </button>
  )
}

export function ScheduleGrid({ schedule, currency, onOverride }) {
  const hasOverride = schedule.periods.some(p => p.callOverridden || p.distributionOverridden)

  return (
    <div className="panel p-5">
      <div className="flex items-baseline justify-between mb-1">
        <h3 className="font-display font-medium text-text-primary">Projected cash-flow schedule</h3>
        {hasOverride && (
          <span className="flex items-center gap-1.5 font-body text-data-sm text-data-flag">
            <RotateCcw size={11} /> contains overrides
          </span>
        )}
      </div>
      <p className="font-body text-data-sm text-text-muted mb-4">Quarter by quarter. Click any call or distribution to override it with a known figure.</p>

      <div className="overflow-x-auto -mx-2">
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-b border-border-subtle">
              {['Quarter', 'Call', 'Distribution', 'Net', 'Cum. called', 'Cum. distributed', 'Cum. net'].map((h, i) => (
                <th key={h} className={`font-mono text-label uppercase tracking-widest text-text-label py-2 px-2 ${i === 0 ? 'text-left' : 'text-right'}`}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {schedule.periods.map(p => (
              <tr key={p.date} className="border-b border-border-subtle/50 hover:bg-surface-800/40 transition-colors">
                <td className="py-1 px-2 font-mono text-data-sm text-text-secondary whitespace-nowrap">{p.label}</td>
                <td className="py-1 px-2">
                  <OverrideCell value={p.call} overridden={p.callOverridden} tone="text-data-negative" onCommit={v => onOverride(p.date, 'call', v)} />
                </td>
                <td className="py-1 px-2">
                  <OverrideCell value={p.distribution} overridden={p.distributionOverridden} tone="text-data-positive" onCommit={v => onOverride(p.date, 'distribution', v)} />
                </td>
                <td className="py-1 px-2 text-right data-value text-data-sm" style={{ color: p.netCashFlow >= 0 ? 'var(--data-positive)' : 'var(--data-negative)' }}>
                  {formatCurrency(p.netCashFlow, currency)}
                </td>
                <td className="py-1 px-2 text-right data-value text-data-sm text-text-muted">{formatCurrency(p.cumulativeCalled, currency)}</td>
                <td className="py-1 px-2 text-right data-value text-data-sm text-text-muted">{formatCurrency(p.cumulativeDistributed, currency)}</td>
                <td className="py-1 px-2 text-right data-value text-data-sm" style={{ color: p.cumulativeNet >= 0 ? 'var(--data-positive)' : 'var(--text-secondary)' }}>
                  {formatCurrency(p.cumulativeNet, currency)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
