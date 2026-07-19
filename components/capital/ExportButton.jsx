'use client'
import { useState } from 'react'
import { Download } from 'lucide-react'

const COLUMNS = [
  ['quarter', 'Quarter'],
  ['call', 'Projected Call'],
  // Distributions pass through the whole-fund waterfall — the schedule is LP-net,
  // never gross, so the export says so explicitly.
  ['distribution', 'LP-net Distribution'],
  ['netCashFlow', 'Net Cash Flow'],
  ['cumulativeCalled', 'Cumulative Called'],
  ['cumulativeDistributed', 'Cumulative Distributed'],
  ['cumulativeNet', 'Cumulative Net'],
]

function toRows(schedule) {
  return schedule.periods.map(p => ({
    quarter: p.label,
    call: Math.round(p.call),
    distribution: Math.round(p.distribution),
    netCashFlow: Math.round(p.netCashFlow),
    cumulativeCalled: Math.round(p.cumulativeCalled),
    cumulativeDistributed: Math.round(p.cumulativeDistributed),
    cumulativeNet: Math.round(p.cumulativeNet),
  }))
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export function ExportButton({ schedule, fundName }) {
  const [busy, setBusy] = useState(false)
  const base = (fundName || 'fundlens-capital').replace(/[^a-z0-9]+/gi, '-').toLowerCase()

  const exportCsv = () => {
    const rows = toRows(schedule)
    const header = COLUMNS.map(c => c[1]).join(',')
    const body = rows.map(r => COLUMNS.map(c => r[c[0]]).join(',')).join('\n')
    download(new Blob([`${header}\n${body}`], { type: 'text/csv' }), `${base}-schedule.csv`)
  }

  const exportXlsx = async () => {
    setBusy(true)
    try {
      const { utils, write } = await import('xlsx')
      const rows = toRows(schedule).map(r => {
        const out = {}
        for (const [key, label] of COLUMNS) out[label] = r[key]
        return out
      })
      const ws = utils.json_to_sheet(rows)
      const wb = utils.book_new()
      utils.book_append_sheet(wb, ws, 'Cash-Flow Schedule')
      const buf = write(wb, { bookType: 'xlsx', type: 'array' })
      download(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `${base}-schedule.xlsx`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex items-center gap-2">
      <button onClick={exportCsv} className="flex items-center gap-1.5 px-3 py-2 rounded-card border border-border-subtle font-mono text-data-sm text-text-secondary hover:text-text-primary hover:border-accent-border transition-colors">
        <Download size={13} /> CSV
      </button>
      <button onClick={exportXlsx} disabled={busy} className="flex items-center gap-1.5 px-3 py-2 rounded-card border border-border-subtle font-mono text-data-sm text-text-secondary hover:text-text-primary hover:border-accent-border transition-colors disabled:opacity-50">
        <Download size={13} /> {busy ? 'Building…' : 'Excel'}
      </button>
    </div>
  )
}
