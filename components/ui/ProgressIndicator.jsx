'use client'

const STEPS = [
  { label: 'Upload',  key: 1 },
  { label: 'Confirm', key: 2 },
  { label: 'Pacing',  key: 3 },
  { label: 'Results', key: 4 },
]

function stepIndex(step) {
  if (step === 'upload')  return 1
  if (step === 'confirm') return 2
  if (step === 'pacing')  return 3
  if (step === 'results') return 4
  return 1
}

export function ProgressIndicator({ step }) {
  const current = stepIndex(step)

  return (
    <div className="flex items-center gap-0">
      {STEPS.map((s, i) => {
        const active    = s.key === current
        const completed = s.key < current
        const upcoming  = s.key > current

        return (
          <div key={s.key} className="flex items-center">
            {/* Step node */}
            <div className="flex flex-col items-center gap-1.5">
              <div
                className={[
                  'w-5 h-5 rounded-full flex items-center justify-center transition-all duration-300',
                  completed ? 'bg-accent'         : '',
                  active    ? 'ring-1 ring-accent ring-offset-1 ring-offset-surface-950 bg-accent-subtle' : '',
                  upcoming  ? 'bg-surface-700'    : '',
                ].join(' ')}
              >
                {completed && (
                  <svg width="8" height="6" viewBox="0 0 8 6" fill="none" className="flex-shrink-0">
                    <path d="M1 3L3 5L7 1" stroke="var(--surface-950)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
                {(active || upcoming) && (
                  <span
                    className={[
                      'font-mono text-[9px] font-medium leading-none',
                      active  ? 'text-accent' : 'text-text-muted',
                    ].join(' ')}
                  >
                    {s.key}
                  </span>
                )}
              </div>
              <span
                className={[
                  'hidden sm:block text-label font-body whitespace-nowrap transition-colors duration-300',
                  active    ? 'text-text-secondary' : '',
                  completed ? 'text-text-muted'     : '',
                  upcoming  ? 'text-text-muted opacity-50' : '',
                ].join(' ')}
              >
                {s.label}
              </span>
            </div>

            {/* Connector */}
            {i < STEPS.length - 1 && (
              <div className="w-12 sm:w-16 h-px mx-2 mb-5 overflow-hidden bg-surface-700">
                <div
                  className="h-full bg-accent transition-all duration-500 ease-out"
                  style={{ width: completed ? '100%' : '0%' }}
                />
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
