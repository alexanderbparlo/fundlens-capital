// Helpers for the /api/capital/extract route: build the Anthropic message content,
// validate the upload payload and the model's response shape, and assemble the
// model output into the engine's ConfirmedFields shape with defaults + derivation.
import { deriveCapitalFields, normalizeMagnitude } from './extractionUtils'

// Builds the Anthropic message content array. PDFs become document blocks; parsed
// Excel/CSV JSON becomes a formatted text block.
export function buildExtractionContent(primaryFile, secondaryFile) {
  const blocks = []
  blocks.push(...fileToBlocks(primaryFile, 'Primary'))
  if (secondaryFile) blocks.push(...fileToBlocks(secondaryFile, 'Supplementary'))
  blocks.push({
    type: 'text',
    text: 'Extract all LP-specific fields from the document(s) above according to the JSON schema and field definitions in your instructions. Return only the JSON object.',
  })
  return blocks
}

function fileToBlocks(file, label) {
  if (file.dataType === 'base64') {
    return [
      {
        type: 'document',
        source: { type: 'base64', media_type: file.mimeType, data: file.data },
        title: file.name,
      },
    ]
  }
  const formatted = formatJsonData(file.data)
  return [
    {
      type: 'text',
      text: `${label} file: ${file.name}\n\nParsed tabular data (${Array.isArray(file.data) ? file.data.length : 0} rows):\n${formatted}`,
    },
  ]
}

function formatJsonData(data) {
  if (!Array.isArray(data) || data.length === 0) return '(empty)'
  const rows = data.length > 500 ? data.slice(0, 500) : data
  const suffix = data.length > 500 ? `\n...(truncated — ${data.length - 500} additional rows not shown)` : ''
  return JSON.stringify(rows, null, 2) + suffix
}

// Server-side size guard: 3MB binary → ~4MB base64, under Vercel's 4.5MB body limit.
const MAX_BASE64_CHARS = 4_200_000

export function validateFilePayload(file, label) {
  if (!file || typeof file !== 'object') return `${label} file is missing or invalid`
  if (!file.name || !file.mimeType || !file.dataType || file.data === undefined) {
    return `${label} file is missing required fields (name, mimeType, dataType, data)`
  }
  if (!['base64', 'json'].includes(file.dataType)) {
    return `${label} file has unrecognised dataType: ${file.dataType}`
  }
  if (file.dataType === 'base64' && typeof file.data === 'string' && file.data.length > MAX_BASE64_CHARS) {
    return `${label} file exceeds the 3 MB size limit`
  }
  return null
}

export function validateExtractionResponse(data) {
  if (!data || typeof data !== 'object') return { valid: false, reason: 'Response is not an object' }
  if (!data.fund || typeof data.fund !== 'object') return { valid: false, reason: 'Missing fund object' }
  if (!data.fundTerms || typeof data.fundTerms !== 'object') return { valid: false, reason: 'Missing fundTerms object' }
  if (!data.fieldSources || typeof data.fieldSources !== 'object') return { valid: false, reason: 'Missing fieldSources object' }
  return { valid: true }
}

const VALID_CATCH_UP = new Set(['full', 'none'])
const VALID_COMPOUNDING = new Set(['compound', 'simple'])

// Maps the model output into the engine's ConfirmedFields shape, applies the
// called/unfunded/commitment derivation, and fills sensible defaults. Returns
// { fields, fieldSources, extractionNotes } for the confirmation gate.
export function assembleFields(extracted) {
  const f = extracted.fund ?? {}
  const t = extracted.fundTerms ?? {}
  const sources = { ...extracted.fieldSources }

  const triangle = deriveCapitalFields({
    commitment: numOrNull(f.commitment),
    calledToDate: numOrNull(f.calledToDate),
    unfundedCommitment: numOrNull(f.unfundedCommitment),
  })

  // Promote any field the derivation filled from "missing" to "derived".
  for (const key of triangle.derived) {
    const sourceKey = `fund.${key}`
    if (sources[sourceKey] === 'missing' || sources[sourceKey] === undefined) {
      sources[sourceKey] = 'derived'
    }
  }

  const fields = {
    fundName: f.fundName ?? null,
    currency: f.currency ?? 'USD',
    asOfDate: f.asOfDate ?? null,
    vintageDate: f.vintageDate ?? null,
    investmentPeriodEndDate: f.investmentPeriodEndDate ?? null,
    fundEndDate: f.fundEndDate ?? null,
    commitment: triangle.commitment,
    calledToDate: triangle.calledToDate,
    unfundedCommitment: triangle.unfundedCommitment,
    distributionsToDate: numOrNull(f.distributionsToDate),
    currentNav: numOrNull(f.currentNav),
    fundTerms: {
      hurdleRate: numOrNull(t.hurdleRate),
      carryRate: numOrNull(t.carryRate),
      catchUp: VALID_CATCH_UP.has(t.catchUp) ? t.catchUp : null,
      preferredCompounding: VALID_COMPOUNDING.has(t.preferredCompounding) ? t.preferredCompounding : null,
    },
    historicalCalls: normalizeSeries(extracted.historicalCalls),
    historicalDistributions: normalizeSeries(extracted.historicalDistributions),
  }

  return { fields, fieldSources: sources, extractionNotes: extracted.extractionNotes ?? '' }
}

function numOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function normalizeSeries(series) {
  if (!Array.isArray(series)) return []
  return series
    .map(e => ({ date: typeof e?.date === 'string' ? e.date : null, amount: normalizeMagnitude(e?.amount) }))
    .filter(e => e.date && e.amount !== null)
}
