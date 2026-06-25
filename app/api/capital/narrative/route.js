import { NextResponse } from 'next/server'
import client from '@/lib/anthropic/client'
import { handleAnthropicError } from '@/lib/anthropic/errorHandler'
import { checkRateLimit, getClientIdentifier, rateLimitHeaders } from '@/lib/rateLimit'
import { NARRATIVE_SYSTEM_PROMPT } from '@/lib/prompts/capitalPrompts'
import { setRunNarrative } from '@/lib/db/runs'

export const maxDuration = 120

// Builds the structured, already-computed summary the narrative agent describes.
// Only finished figures are passed — the model never sees raw inputs to recompute.
function buildNarrativeInput({ fields, schedule, liquidity }) {
  const fmtQ = d => {
    if (!d) return null
    const date = new Date(d)
    return `Q${Math.floor(date.getUTCMonth() / 3) + 1} ${date.getUTCFullYear()}`
  }
  const breakdown = schedule.distributionBreakdown ?? {}
  const gpCarryProjected = (breakdown.gpCatchUp ?? 0) + (breakdown.gpProfitSplit ?? 0)

  return {
    fundName: fields.fundName,
    currency: fields.currency,
    asOfDate: fields.asOfDate,
    commitment: fields.commitment,
    calledToDate: fields.calledToDate,
    unfundedCommitment: fields.unfundedCommitment,
    distributionsToDate: fields.distributionsToDate,
    currentNav: fields.currentNav,
    totalProjectedCalls: schedule.totalProjectedCalls,
    totalProjectedDistributions: schedule.totalProjectedDistributions,
    peakFundingNeed: liquidity.peakFundingNeed
      ? { amount: liquidity.peakFundingNeed.value, quarter: fmtQ(liquidity.peakFundingNeed.date) }
      : null,
    crossoverQuarter: schedule.crossover ? fmtQ(schedule.crossover.date) : null,
    rollingLiquidityRequired: liquidity.rollingLiquidityRequired,
    // Projected distributions are ALWAYS net of carry — they run through the
    // European waterfall by construction. gpCarryProjected is the carry amount,
    // which is zero when the LP has not yet cleared its preferred return.
    distributionsNetOfCarry: true,
    gpCarryProjected,
    carryBindsInProjection: gpCarryProjected > 0,
  }
}

export async function POST(request) {
  const identifier = getClientIdentifier(request)
  const rateResult = await checkRateLimit('narrative', identifier)
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

  const { fields, schedule, liquidity, runId } = body
  if (!fields || !schedule || !liquidity) {
    return NextResponse.json(
      { success: false, error: 'Missing projection data for the narrative.' },
      { status: 400 }
    )
  }

  const narrativeInput = buildNarrativeInput({ fields, schedule, liquidity })

  try {
    const response = await client.messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 4000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'xhigh' },
      system: NARRATIVE_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: `Here is the finished, computed LP cash-flow projection. Describe it per your instructions.\n\n${JSON.stringify(narrativeInput, null, 2)}`,
        },
      ],
    })

    const narrative = response.content.find(b => b.type === 'text')?.text ?? ''
    if (!narrative) {
      return NextResponse.json(
        { success: false, error: 'Narrative produced no output. Please try again.' },
        { status: 500 }
      )
    }

    if (runId) {
      try {
        await setRunNarrative(runId, narrative)
      } catch (err) {
        console.error('Narrative: persistence error', err)
      }
    }

    return NextResponse.json(
      { success: true, data: { narrative } },
      { headers: rateLimitHeaders(rateResult) }
    )
  } catch (err) {
    return handleAnthropicError(err)
  }
}
