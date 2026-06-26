'use client'
import { formatCurrency } from '@/lib/utils'

// The marquee LP-specific output: the unfunded commitment reframed as a dated
// treasury obligation, plus the rolling dry-powder figure.
export function LiquidityView({ liquidity, currency }) {
  const next = q => liquidity.rollingLiquidityRequired.find(r => r.quarters === q)?.amount ?? 0

  return (
    <div className="panel p-5">
      <h3 className="font-display font-medium text-text-primary mb-1">Net liquidity / treasury view</h3>
      <p className="font-body text-data-sm text-text-muted mb-5">How much committed-but-uncalled capital to keep liquid, and when it is returned.</p>

      {/* Rolling dry-powder figures */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        {[
          { label: 'Unfunded (RCC)', value: liquidity.openingUnfunded, accent: true },
          { label: 'Next 4 quarters', value: next(4) },
          { label: 'Next 8 quarters', value: next(8) },
          { label: 'Next 12 quarters', value: next(12) },
        ].map(card => (
          <div key={card.label} className="card px-3 py-3">
            <p className="font-mono text-label uppercase tracking-widest text-text-label mb-1.5">{card.label}</p>
            <p className={`data-value text-data-lg ${card.accent ? 'text-accent' : 'text-text-primary'}`}>
              {formatCurrency(card.value, currency)}
            </p>
            {!card.accent && <p className="font-body text-data-sm text-text-muted mt-0.5">liquidity required</p>}
          </div>
        ))}
      </div>

      {liquidity.peakFundingNeed && (
        <div className="scope-banner px-4 py-3 mb-6 flex items-baseline gap-2">
          <span className="font-body text-data-sm text-text-secondary">Peak funding need</span>
          <span className="data-value text-data-sm text-data-flag">{formatCurrency(liquidity.peakFundingNeed.value, currency)}</span>
          <span className="font-body text-data-sm text-text-muted">— forward dry powder to keep on hand from the as-of date; prior calls treated as done, bounded by remaining unfunded.</span>
        </div>
      )}

      {/* Per-quarter treasury table */}
      <div className="overflow-x-auto -mx-2">
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-b border-border-subtle">
              {['Quarter', 'Liquidity needed', 'Running unfunded', 'Returned', 'Net'].map((h, i) => (
                <th key={h} className={`font-mono text-label uppercase tracking-widest text-text-label py-2 px-2 ${i === 0 ? 'text-left' : 'text-right'}`}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {liquidity.periods.map(p => (
              <tr key={p.date} className="border-b border-border-subtle/50">
                <td className="py-1 px-2 font-mono text-data-sm text-text-secondary whitespace-nowrap">{p.label}</td>
                <td className="py-1 px-2 text-right data-value text-data-sm text-data-negative">{p.call ? formatCurrency(p.call, currency) : '—'}</td>
                <td className="py-1 px-2 text-right data-value text-data-sm text-text-muted">{formatCurrency(p.runningUnfunded, currency)}</td>
                <td className="py-1 px-2 text-right data-value text-data-sm text-data-positive">{p.distribution ? formatCurrency(p.distribution, currency) : '—'}</td>
                <td className="py-1 px-2 text-right data-value text-data-sm" style={{ color: p.netLiquidity >= 0 ? 'var(--data-positive)' : 'var(--data-negative)' }}>
                  {formatCurrency(p.netLiquidity, currency)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
