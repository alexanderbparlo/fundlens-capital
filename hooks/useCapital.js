'use client'
import { useState, useCallback, useRef } from 'react'
import { fileToBase64 } from '@/lib/utils'
import { buildSchedule } from '@/lib/capital/schedule'
import { buildLiquidityView } from '@/lib/capital/liquidityView'

const ACCEPTED_MIME_TYPES = [
  'application/pdf',
  'text/csv',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]
const MAX_SIZE_BYTES = 3 * 1024 * 1024
const MAX_COMBINED_SIZE_BYTES = 3 * 1024 * 1024

export const DEFAULT_PACING = {
  callCurve: 'front-loaded',
  callDecay: 0.7,
  forwardValueMultiple: 1.6,
  avgRemainingHoldYears: 5,
  overrides: [],
}

async function parseUploadedFile(file) {
  if (file.type === 'application/pdf') {
    const base64 = await fileToBase64(file)
    return { name: file.name, mimeType: file.type, size: file.size, dataType: 'base64', data: base64 }
  }
  if (file.type === 'text/csv') {
    const Papa = (await import('papaparse')).default
    const text = await file.text()
    const result = Papa.parse(text, { header: true, skipEmptyLines: true })
    return { name: file.name, mimeType: file.type, size: file.size, dataType: 'json', data: result.data }
  }
  const { read, utils } = await import('xlsx')
  const buffer = await file.arrayBuffer()
  const workbook = read(buffer)
  const firstSheet = workbook.Sheets[workbook.SheetNames[0]]
  const data = utils.sheet_to_json(firstSheet)
  return { name: file.name, mimeType: file.type, size: file.size, dataType: 'json', data }
}

function validateFile(file) {
  if (!ACCEPTED_MIME_TYPES.includes(file.type)) return 'Only PDF, Excel (.xlsx), and CSV files are accepted.'
  if (file.size > MAX_SIZE_BYTES) return 'File must be under 3MB.'
  return null
}

export function useCapital() {
  const [step, setStep] = useState('upload') // 'upload' | 'confirm' | 'pacing' | 'results'

  // Upload
  const [primaryFile, setPrimaryFile] = useState(null)
  const [secondaryFile, setSecondaryFile] = useState(null)
  const [isProcessingFile, setIsProcessingFile] = useState(false)
  const [fileError, setFileError] = useState(null)

  // Extract
  const [isExtracting, setIsExtracting] = useState(false)
  const [extractedFields, setExtractedFields] = useState(null) // { fields, fieldSources, extractionNotes }
  const [extractError, setExtractError] = useState(null)

  // Confirm → engine ConfirmedFields
  const [confirmedFields, setConfirmedFields] = useState(null)

  // Pacing
  const [pacingConfig, setPacingConfig] = useState(DEFAULT_PACING)

  // Project (deterministic)
  const [isProjecting, setIsProjecting] = useState(false)
  const [schedule, setSchedule] = useState(null)
  const [liquidity, setLiquidity] = useState(null)
  const [projectError, setProjectError] = useState(null)
  const [runId, setRunId] = useState(null)

  // Narrative
  const [isGeneratingNarrative, setIsGeneratingNarrative] = useState(false)
  const [narrative, setNarrative] = useState(null)

  // Run reload-by-URL
  const [isLoadingRun, setIsLoadingRun] = useState(false)
  const [loadRunError, setLoadRunError] = useState(null)

  const persistTimer = useRef(null)

  // ── Upload ──────────────────────────────────────────────────────────────────
  const processFile = useCallback(async (file, setter) => {
    const error = validateFile(file)
    if (error) { setFileError(error); return false }
    setFileError(null)
    setIsProcessingFile(true)
    try {
      const processed = await parseUploadedFile(file)
      setter(processed)
      return true
    } catch (err) {
      setFileError('Failed to read file. Check that it is not corrupted and try again.')
      console.error('File parse error:', err)
      return false
    } finally {
      setIsProcessingFile(false)
    }
  }, [])

  const handlePrimaryFile = useCallback(file => processFile(file, setPrimaryFile), [processFile])
  const handleSecondaryFile = useCallback(file => processFile(file, setSecondaryFile), [processFile])
  const clearPrimaryFile = useCallback(() => { setPrimaryFile(null); setFileError(null) }, [])
  const clearSecondaryFile = useCallback(() => setSecondaryFile(null), [])
  const clearExtractError = useCallback(() => setExtractError(null), [])

  // ── Extract ─────────────────────────────────────────────────────────────────
  const extractFields = useCallback(async () => {
    if (!primaryFile) return
    const combined = (primaryFile?.size ?? 0) + (secondaryFile?.size ?? 0)
    if (combined > MAX_COMBINED_SIZE_BYTES) {
      setExtractError('Combined file size must be under 3MB. Try uploading one file at a time.')
      return
    }

    setIsExtracting(true)
    setExtractError(null)
    try {
      const pick = f => f && { name: f.name, mimeType: f.mimeType, dataType: f.dataType, data: f.data }
      const body = { primaryFile: pick(primaryFile), ...(secondaryFile && { secondaryFile: pick(secondaryFile) }) }
      const res = await fetch('/api/capital/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })

      let json
      try {
        json = await res.json()
      } catch {
        setExtractError(
          res.status === 504
            ? 'Extraction timed out. The document may be too complex — try again or use a shorter file.'
            : res.status === 413
            ? 'File too large for the server. Please use a file under 3MB.'
            : `Server error (${res.status}). Please try again.`
        )
        return
      }

      if (!res.ok || !json.success) {
        setExtractError(json.error || 'Extraction failed. Please try again.')
        return
      }

      setExtractedFields(json.data)
      setConfirmedFields(json.data.fields)
      setStep('confirm')
    } catch (err) {
      setExtractError('Network error. Please check your connection and try again.')
      console.error('Extract error:', err)
    } finally {
      setIsExtracting(false)
    }
  }, [primaryFile, secondaryFile])

  // ── Confirm gate ──────────────────────────────────────────────────────────────
  const confirmFields = useCallback(fields => {
    setConfirmedFields(fields)
    setStep('pacing')
  }, [])

  // ── Project (deterministic) ───────────────────────────────────────────────────
  const runProjection = useCallback(async (fields, config) => {
    const f = fields ?? confirmedFields
    const c = config ?? pacingConfig
    if (!f) return
    setIsProjecting(true)
    setProjectError(null)
    setStep('results')
    try {
      const res = await fetch('/api/capital/project', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmedFields: f, pacingConfig: c }),
      })
      const json = await res.json()
      if (!res.ok || !json.success) {
        setProjectError(json.error || 'Projection failed. Please review your inputs.')
        return
      }
      setSchedule(json.data.schedule)
      setLiquidity(json.data.liquidity)
      setRunId(json.data.runId)
    } catch (err) {
      setProjectError('Network error. Please check your connection and try again.')
      console.error('Project error:', err)
    } finally {
      setIsProjecting(false)
    }
  }, [confirmedFields, pacingConfig])

  // Recompute instantly client-side (pure engine), then debounce-persist the update.
  const recomputeAndPersist = useCallback((fields, config) => {
    try {
      const nextSchedule = buildSchedule(fields, config)
      const nextLiquidity = buildLiquidityView(nextSchedule, fields)
      setSchedule(nextSchedule)
      setLiquidity(nextLiquidity)
    } catch (err) {
      console.error('Recompute error:', err)
      return
    }
    if (persistTimer.current) clearTimeout(persistTimer.current)
    persistTimer.current = setTimeout(() => {
      fetch('/api/capital/project', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmedFields: fields, pacingConfig: config, runId }),
      })
        .then(r => r.json())
        .then(j => { if (j?.success && j.data?.runId) setRunId(j.data.runId) })
        .catch(err => console.error('Persist error:', err))
    }, 800)
  }, [runId])

  // Set or clear a per-period override, recomputing the schedule immediately.
  const setOverride = useCallback((date, field, value) => {
    setPacingConfig(prev => {
      const overrides = prev.overrides.filter(o => o.date !== date)
      const existing = prev.overrides.find(o => o.date === date) ?? { date }
      const next = { ...existing, [field]: value }
      // Drop the override entirely if both fields are cleared.
      const cleaned = (next.call == null && next.distribution == null) ? overrides : [...overrides, next]
      const config = { ...prev, overrides: cleaned }
      if (confirmedFields) recomputeAndPersist(confirmedFields, config)
      return config
    })
  }, [confirmedFields, recomputeAndPersist])

  // ── Narrative ─────────────────────────────────────────────────────────────────
  const generateNarrative = useCallback(async () => {
    if (!schedule || !liquidity || !confirmedFields) return
    if (narrative) return
    setIsGeneratingNarrative(true)
    try {
      const res = await fetch('/api/capital/narrative', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: confirmedFields, schedule, liquidity, runId }),
      })
      const json = await res.json()
      if (res.ok && json.success) setNarrative(json.data.narrative)
    } catch (err) {
      console.error('Narrative error:', err)
    } finally {
      setIsGeneratingNarrative(false)
    }
  }, [schedule, liquidity, confirmedFields, narrative, runId])

  // ── Reload a persisted run by id ────────────────────────────────────────────────
  const loadRun = useCallback(async id => {
    setIsLoadingRun(true)
    setLoadRunError(null)
    try {
      const res = await fetch(`/api/capital/run/${id}`)
      const json = await res.json()
      if (!res.ok || !json.success) {
        setLoadRunError(json.error || 'Run not found.')
        return
      }
      const run = json.data
      setConfirmedFields(run.confirmedFields)
      setPacingConfig(run.pacingConfig)
      setSchedule(run.schedule)
      setLiquidity(run.liquidity)
      setNarrative(run.narrative ?? null)
      setRunId(run.id)
      setStep('results')
    } catch (err) {
      setLoadRunError('Failed to load the saved run.')
      console.error('Load run error:', err)
    } finally {
      setIsLoadingRun(false)
    }
  }, [])

  // ── Navigation ────────────────────────────────────────────────────────────────
  const goBack = useCallback(() => {
    const order = ['upload', 'confirm', 'pacing', 'results']
    const idx = order.indexOf(step)
    if (idx > 0) {
      if (step === 'results') {
        setSchedule(null)
        setLiquidity(null)
        setProjectError(null)
        setNarrative(null)
        setIsGeneratingNarrative(false)
      }
      setStep(order[idx - 1])
    }
  }, [step])

  const resetAll = useCallback(() => {
    setStep('upload')
    setPrimaryFile(null)
    setSecondaryFile(null)
    setFileError(null)
    setIsProcessingFile(false)
    setIsExtracting(false)
    setExtractedFields(null)
    setExtractError(null)
    setConfirmedFields(null)
    setPacingConfig(DEFAULT_PACING)
    setIsProjecting(false)
    setSchedule(null)
    setLiquidity(null)
    setProjectError(null)
    setRunId(null)
    setIsGeneratingNarrative(false)
    setNarrative(null)
    setIsLoadingRun(false)
    setLoadRunError(null)
  }, [])

  return {
    step,
    primaryFile, secondaryFile, isProcessingFile, fileError,
    isExtracting, extractedFields, extractError,
    confirmedFields, pacingConfig,
    isProjecting, schedule, liquidity, projectError, runId,
    isGeneratingNarrative, narrative,
    isLoadingRun, loadRunError,
    handlePrimaryFile, handleSecondaryFile, clearPrimaryFile, clearSecondaryFile, clearExtractError,
    extractFields, confirmFields,
    setPacingConfig, runProjection, setOverride,
    generateNarrative, goBack, resetAll, loadRun,
    setProjectError,
  }
}
