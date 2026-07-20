'use client'
import { useEffect, useRef } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { AlertCircle } from 'lucide-react'
import { useCapital } from '@/hooks/useCapital'
import { ThemeToggle } from '@/components/ui/ThemeToggle'
import { ProgressIndicator } from '@/components/ui/ProgressIndicator'
import { FileUpload } from '@/components/capital/FileUpload'
import { ConfirmFields } from '@/components/capital/ConfirmFields'
import { PacingConfig } from '@/components/capital/PacingConfig'
import { ResultsDisplay } from '@/components/capital/ResultsDisplay'

const TRANSITION = { duration: 0.32, ease: [0.22, 1, 0.36, 1] }

function ResultsStep({ cap }) {
  // Generate the narrative once the deterministic schedule is ready.
  useEffect(() => {
    if (cap.schedule && cap.liquidity && !cap.narrative && !cap.isGeneratingNarrative) {
      cap.generateNarrative()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cap.schedule, cap.liquidity])

  if (cap.isProjecting || cap.projectError || !cap.schedule) {
    return (
      <div className="w-full max-w-intake mx-auto">
        <p className="font-mono text-label uppercase tracking-widest text-accent mb-3">Results</p>
        {cap.isProjecting && (
          <div className="py-12 flex items-center gap-3">
            <span className="inline-block w-4 h-4 border border-accent border-t-transparent rounded-full animate-spin" />
            <p className="font-body text-sm text-text-secondary">Building the projected schedule…</p>
          </div>
        )}
        {!cap.isProjecting && cap.projectError && (
          <div className="py-8">
            <div className="flex items-start gap-2 mb-5 px-4 py-3 card border-border">
              <AlertCircle size={14} className="text-data-negative flex-shrink-0 mt-0.5" />
              <p className="font-body text-data-sm text-text-secondary">{cap.projectError}</p>
            </div>
            <button onClick={cap.goBack} className="font-body text-sm text-accent hover:text-accent-dim transition-colors">← Back to pacing</button>
          </div>
        )}
      </div>
    )
  }

  return (
    <ResultsDisplay
      fields={cap.confirmedFields}
      schedule={cap.schedule}
      liquidity={cap.liquidity}
      pacingConfig={cap.pacingConfig}
      narrative={cap.narrative}
      isGeneratingNarrative={cap.isGeneratingNarrative}
      runId={cap.runId}
      onOverride={cap.setOverride}
      onBack={cap.goBack}
      onReset={cap.resetAll}
    />
  )
}

export default function CapitalPage() {
  const cap = useCapital()
  const didInit = useRef(false)

  // Hydrate from a shared run link (?run=<id>) once on mount.
  useEffect(() => {
    if (didInit.current) return
    didInit.current = true
    const run = new URLSearchParams(window.location.search).get('run')
    if (run) cap.loadRun(run)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Keep the URL in sync with the persisted run so results are shareable/reloadable.
  useEffect(() => {
    if (!didInit.current) return
    window.history.replaceState(null, '', cap.runId ? `/capital?run=${cap.runId}` : '/capital')
  }, [cap.runId])

  if (cap.isLoadingRun) {
    return (
      <main className="min-h-screen flex items-center justify-center">
        <div className="flex items-center gap-3">
          <span className="inline-block w-4 h-4 border border-accent border-t-transparent rounded-full animate-spin" />
          <p className="font-body text-sm text-text-secondary">Loading saved forecast…</p>
        </div>
      </main>
    )
  }

  return (
    <main className="min-h-screen flex flex-col">
      <header className="w-full border-b border-border-subtle">
        <div className="max-w-results mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-baseline gap-2">
            <span className="font-display font-semibold text-text-primary tracking-tight">FundLens</span>
            <span className="font-display font-medium text-accent tracking-tight">Capital</span>
          </div>
          <div className="flex items-center gap-4">
            <ProgressIndicator step={cap.step} />
            <ThemeToggle />
          </div>
        </div>
      </header>

      <section className="flex-1 w-full px-6 py-12">
        {cap.loadRunError && cap.step === 'upload' && (
          <div className="w-full max-w-intake mx-auto mb-6 flex items-start gap-2 px-4 py-3 card border-border">
            <AlertCircle size={14} className="text-data-negative flex-shrink-0 mt-0.5" />
            <p className="font-body text-data-sm text-text-secondary">
              {cap.loadRunError} Starting a new forecast.
            </p>
          </div>
        )}
        <AnimatePresence mode="wait">
          <motion.div
            key={cap.step}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={TRANSITION}
          >
            {cap.step === 'upload' && (
              <FileUpload
                primaryFile={cap.primaryFile}
                secondaryFile={cap.secondaryFile}
                isProcessingFile={cap.isProcessingFile}
                fileError={cap.fileError}
                isExtracting={cap.isExtracting}
                extractError={cap.extractError}
                onPrimaryFile={cap.handlePrimaryFile}
                onSecondaryFile={cap.handleSecondaryFile}
                onClearPrimary={cap.clearPrimaryFile}
                onClearSecondary={cap.clearSecondaryFile}
                onExtract={cap.extractFields}
                onClearExtractError={cap.clearExtractError}
              />
            )}

            {cap.step === 'confirm' && (
              <ConfirmFields
                extracted={cap.extractedFields}
                initialFields={cap.confirmedFields}
                onConfirm={cap.confirmFields}
                onBack={cap.goBack}
              />
            )}

            {cap.step === 'pacing' && (
              <PacingConfig
                fields={cap.confirmedFields}
                initialConfig={cap.pacingConfig}
                onRun={config => { cap.setPacingConfig(config); cap.runProjection(cap.confirmedFields, config) }}
                onBack={cap.goBack}
              />
            )}

            {cap.step === 'results' && <ResultsStep cap={cap} />}
          </motion.div>
        </AnimatePresence>
      </section>
    </main>
  )
}
