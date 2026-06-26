'use client'
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine, ReferenceDot } from 'recharts'
import { formatCurrency } from '@/lib/utils'

function CustomTooltip({ active, payload, currency }) {
  if (!active || !payload?.length) return null
  const p = payload[0].payload
  return (
    <div className="card px-3 py-2 border-border">
      <p className="font-mono text-label uppercase tracking-widest text-text-label mb-1">{p.label}</p>
      <p className="data-value text-data-sm" style={{ color: p.cumulativeNet >= 0 ? 'var(--data-positive)' : 'var(--data-negative)' }}>
        {formatCurrency(p.cumulativeNet, currency)}
      </p>
      <p className="font-body text-data-sm text-text-muted">cumulative net</p>
    </div>
  )
}

export function JCurveChart({ schedule, currency }) {
  const data = [
    { label: 'Now', cumulativeNet: schedule.openingCumulativeNet, date: schedule.asOfDate },
    ...schedule.periods.map(p => ({ label: p.label, cumulativeNet: p.cumulativeNet, date: p.date })),
  ]

  const trough = schedule.trough
  const crossover = schedule.crossover
  const crossoverPoint = crossover ? data.find(d => d.date === crossover.date) : null
  const troughPoint = trough ? data.find(d => d.date === trough.date) : null

  return (
    <div className="panel p-5">
      <div className="flex items-baseline justify-between mb-1">
        <h3 className="font-display font-medium text-text-primary">J-curve — cumulative net cash flow</h3>
        <span className="font-body text-data-sm text-text-muted">trough → crossover</span>
      </div>
      <p className="font-body text-data-sm text-text-muted mb-4">Net position over time, opening from capital called and distributions received to date.</p>

      {/* Constrained toward a ~1:1 aspect so the J-curve's curvature reads naturally
          instead of being flattened across a wide container. Recharts scales the Y
          domain to the data independently of pixel size, so the aspect change does not
          distort axis scaling. */}
      <div className="mx-auto w-full max-w-[480px]">
      <ResponsiveContainer width="100%" aspect={1.1} minHeight={300}>
        <AreaChart data={data} margin={{ top: 12, right: 8, bottom: 0, left: 8 }}>
          <defs>
            <linearGradient id="jcurveFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.18} />
              <stop offset="100%" stopColor="var(--accent)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <XAxis dataKey="label" tick={{ fontSize: 10, fontFamily: 'var(--font-mono)', fill: 'var(--text-muted)' }} interval="preserveStartEnd" minTickGap={40} axisLine={{ stroke: 'var(--border-subtle)' }} tickLine={false} />
          <YAxis tickFormatter={v => formatCurrency(v, currency)} tick={{ fontSize: 10, fontFamily: 'var(--font-mono)', fill: 'var(--text-muted)' }} width={60} axisLine={false} tickLine={false} padding={{ top: 8, bottom: 8 }} />
          <Tooltip content={<CustomTooltip currency={currency} />} />
          <ReferenceLine y={0} stroke="var(--border)" strokeDasharray="3 3" />
          <Area type="monotone" dataKey="cumulativeNet" stroke="var(--accent)" strokeWidth={2} fill="url(#jcurveFill)" animationDuration={700} dot={false} />
          {troughPoint && <ReferenceDot x={troughPoint.label} y={troughPoint.cumulativeNet} r={4} fill="var(--data-negative)" stroke="none" />}
          {crossoverPoint && <ReferenceDot x={crossoverPoint.label} y={crossoverPoint.cumulativeNet} r={4} fill="var(--data-positive)" stroke="none" />}
        </AreaChart>
      </ResponsiveContainer>
      </div>
    </div>
  )
}
