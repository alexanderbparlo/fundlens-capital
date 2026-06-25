import { NextResponse } from 'next/server'
import client from '@/lib/anthropic/client'
import { handleAnthropicError } from '@/lib/anthropic/errorHandler'
import { checkRateLimit, getClientIdentifier, rateLimitHeaders } from '@/lib/rateLimit'
import { parseJsonResponse } from '@/lib/utils'
import { EXTRACT_SYSTEM_PROMPT } from '@/lib/prompts/capitalPrompts'
import {
  assembleFields,
  buildExtractionContent,
  validateExtractionResponse,
  validateFilePayload,
} from '@/lib/capital/extractApi'

export const maxDuration = 300

export async function POST(request) {
  const identifier = getClientIdentifier(request)
  const rateResult = await checkRateLimit('extract', identifier)
  if (!rateResult.success) {
    return NextResponse.json(
      { success: false, error: 'Rate limit reached. Please wait before submitting another document.' },
      { status: 429, headers: rateLimitHeaders(rateResult) }
    )
  }

  let body
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid request body.' }, { status: 400 })
  }

  const { primaryFile, secondaryFile } = body

  const primaryError = validateFilePayload(primaryFile, 'Primary')
  if (primaryError) {
    return NextResponse.json({ success: false, error: primaryError }, { status: 400 })
  }
  if (secondaryFile !== undefined && secondaryFile !== null) {
    const secondaryError = validateFilePayload(secondaryFile, 'Secondary')
    if (secondaryError) {
      return NextResponse.json({ success: false, error: secondaryError }, { status: 400 })
    }
  }

  const content = buildExtractionContent(primaryFile, secondaryFile ?? null)

  try {
    const response = await client.messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 8000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'xhigh' },
      system: EXTRACT_SYSTEM_PROMPT,
      messages: [{ role: 'user', content }],
    })

    const textBlock = response.content.find(b => b.type === 'text')
    if (!textBlock?.text) {
      console.error('Extract: no text block in response')
      return NextResponse.json(
        { success: false, error: 'Extraction produced no output. Please try again.' },
        { status: 500 }
      )
    }

    let extracted
    try {
      extracted = parseJsonResponse(textBlock.text)
    } catch (err) {
      console.error('Extract: failed to parse model JSON:', err, '\nRaw:', textBlock.text.slice(0, 500))
      return NextResponse.json(
        { success: false, error: 'Extraction output could not be parsed. Please try again.' },
        { status: 500 }
      )
    }

    const validation = validateExtractionResponse(extracted)
    if (!validation.valid) {
      console.error('Extract: invalid response shape:', validation.reason)
      return NextResponse.json(
        { success: false, error: 'Extraction returned an unexpected format. Please try again.' },
        { status: 500 }
      )
    }

    const assembled = assembleFields(extracted)

    return NextResponse.json(
      { success: true, data: assembled },
      { headers: rateLimitHeaders(rateResult) }
    )
  } catch (err) {
    return handleAnthropicError(err)
  }
}
