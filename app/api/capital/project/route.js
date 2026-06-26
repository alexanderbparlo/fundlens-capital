import { NextResponse } from 'next/server'
import { checkRateLimit, getClientIdentifier, rateLimitHeaders } from '@/lib/rateLimit'
import { buildSchedule, ENGINE_VERSION } from '@/lib/capital/schedule'
import { buildLiquidityView } from '@/lib/capital/liquidityView'
import { createRun, updateRun } from '@/lib/db/runs'
import { PROMPT_VERSION } from '@/lib/prompts/capitalPrompts'

// Deterministic projection endpoint. No model call — runs the pure pacing engine on
// the confirmed inputs and persists a run snapshot (when the database is configured).
// Accepts an optional runId so per-period override edits update the same row.
export const maxDuration = 30

const REQUIRED_NUMBERS = [
  'commitment',
  'calledToDate',
  'unfundedCommitment',
  'distributionsToDate',
  'currentNav',
]

const isNum = v => typeof v === 'number' && Number.isFinite(v)

function validateConfirmedFields(f) {
  if (!f || typeof f !== 'object') return 'confirmedFields is missing or invalid.'
  if (!f.asOfDate) return 'As-of date is required.'
  if (!f.investmentPeriodEndDate && !f.fundEndDate) {
    return 'At least one of investment-period-end or fund-end date is required to project.'
  }
  for (const key of REQUIRED_NUMBERS) {
    if (!isNum(f[key])) return `Field "${key}" must be a number.`
  }
  if (!f.fundTerms || typeof f.fundTerms !== 'object') return 'Fund terms are required.'
  if (!isNum(f.fundTerms.hurdleRate) || !isNum(f.fundTerms.carryRate)) {
    return 'Hurdle rate and carry rate are required.'
  }
  return null
}

function normalizeConfig(raw) {
  const c = raw && typeof raw === 'object' ? raw : {}
  return {
    callCurve: c.callCurve === 'history-fit' ? 'history-fit' : 'front-loaded',
    callDecay: isNum(c.callDecay) ? c.callDecay : 0.7,
    forwardValueMultiple: isNum(c.forwardValueMultiple) ? c.forwardValueMultiple : 1.6,
    forwardCallMultiple: isNum(c.forwardCallMultiple) ? c.forwardCallMultiple : 1.4,
    avgRemainingHoldYears: isNum(c.avgRemainingHoldYears) ? c.avgRemainingHoldYears : 5,
    overrides: Array.isArray(c.overrides) ? c.overrides : [],
  }
}

export async function POST(request) {
  const identifier = getClientIdentifier(request)
  const rateResult = await checkRateLimit('project', identifier)
  if (!rateResult.success) {
    return NextResponse.json(
      { success: false, error: 'Rate limit reached. Please wait a moment.' },
      { status: 429, headers: rateLimitHeaders(rateResult) }
    )
  }

  let body
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid request body.' }, { status: 400 })
  }

  const { confirmedFields, runId } = body
  const validationError = validateConfirmedFields(confirmedFields)
  if (validationError) {
    return NextResponse.json({ success: false, error: validationError }, { status: 400 })
  }

  const pacingConfig = normalizeConfig(body.pacingConfig)

  let schedule
  let liquidity
  try {
    schedule = buildSchedule(confirmedFields, pacingConfig)
    liquidity = buildLiquidityView(schedule, confirmedFields)
  } catch (err) {
    console.error('Project: engine error', err)
    return NextResponse.json(
      { success: false, error: 'Projection failed. Please review the confirmed inputs.' },
      { status: 500 }
    )
  }

  // Persist (no-ops gracefully when the database is not configured).
  let persistedRunId = runId ?? null
  try {
    const snapshot = {
      confirmedFields,
      pacingConfig,
      schedule,
      liquidity,
      promptVersion: PROMPT_VERSION,
      engineVersion: ENGINE_VERSION,
    }
    if (persistedRunId) {
      const updated = await updateRun(persistedRunId, snapshot)
      if (!updated) persistedRunId = await createRun(snapshot)
    } else {
      persistedRunId = await createRun(snapshot)
    }
  } catch (err) {
    // Persistence failure must not break the projection — log and continue.
    console.error('Project: persistence error', err)
  }

  return NextResponse.json(
    { success: true, data: { runId: persistedRunId, schedule, liquidity } },
    { headers: rateLimitHeaders(rateResult) }
  )
}
