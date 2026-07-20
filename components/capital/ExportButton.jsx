'use client'
import { useState } from 'react'
import { Download } from 'lucide-react'
import {
  SCHEDULE_COLUMNS,
  buildDisplayRows,
  buildSummaryRows,
  buildCsv,
} from '@/lib/capital/exportRows'

function download(blob, filename) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

// Exports delegate all row/summary construction to lib/capital/exportRows.ts — the
// display-rounding (largest-remainder) and the projection-summary block are pure,
// unit-tested functions; this component only handles the download plumbing.
export function ExportButton({ schedule, fields, config, fundName }) {
  const [busy, setBusy] = useState(false)
  const base = (fundName || 'fundlens-capital').replace(/[^a-z0-9]+/gi, '-').toLowerCase()

  const exportCsv = () => {
    const csv = buildCsv(schedule, fields, config)
    download(new Blob([csv], { type: 'text/csv' }), `${base}-schedule.csv`)
  }

  const exportXlsx = async () => {
    setBusy(true)
    try {
      const { utils, write } = await import('xlsx')
      const rows = buildDisplayRows(schedule).map(r => {
        const out = {}
        for (const [key, label] of SCHEDULE_COLUMNS) out[label] = r[key]
        return out
      })
      const wb = utils.book_new()
      utils.book_append_sheet(wb, utils.json_to_sheet(rows), 'Cash-Flow Schedule')
      const summary = buildSummaryRows(schedule, fields, config).map(([label, value]) => ({
        'Projection Summary': label,
        Value: value,
      }))
      utils.book_append_sheet(wb, utils.json_to_sheet(summary), 'Projection Summary')
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
