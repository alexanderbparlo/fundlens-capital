'use client'

export function NarrativePanel({ narrative, isGenerating }) {
  return (
    <div className="panel p-5">
      <div className="flex items-center gap-2 mb-4">
        <span className="indicator-dot indicator-extracted" />
        <h3 className="font-display font-medium text-text-primary">Summary</h3>
        {isGenerating && <span className="font-body text-data-sm text-text-muted">writing…</span>}
      </div>

      {isGenerating && !narrative ? (
        <div className="space-y-2.5">
          {[100, 96, 92, 88, 70].map((w, i) => (
            <div key={i} className="h-3 rounded-chip shimmer" style={{ width: `${w}%` }} />
          ))}
        </div>
      ) : narrative ? (
        <div className="space-y-3">
          {narrative.split(/\n\n+/).map((para, i) => (
            <p key={i} className="font-body text-sm text-text-secondary leading-relaxed max-w-[72ch]">{para}</p>
          ))}
        </div>
      ) : (
        <p className="font-body text-data-sm text-text-muted">No summary available.</p>
      )}
    </div>
  )
}
