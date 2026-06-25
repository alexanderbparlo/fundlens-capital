import { NextResponse } from 'next/server'
import { checkRateLimit, getClientIdentifier, rateLimitHeaders } from '@/lib/rateLimit'
import { isDbConfigured } from '@/lib/db/client'
import { getRun } from '@/lib/db/runs'

// Reloads a persisted run snapshot by id. Returns 404 when persistence is off or the
// run does not exist.
export async function GET(request, { params }) {
  const identifier = getClientIdentifier(request)
  const rateResult = await checkRateLimit('run', identifier)
  if (!rateResult.success) {
    return NextResponse.json(
      { success: false, error: 'Rate limit reached. Please wait a moment.' },
      { status: 429, headers: rateLimitHeaders(rateResult) }
    )
  }

  if (!isDbConfigured) {
    return NextResponse.json(
      { success: false, error: 'Run persistence is not enabled in this environment.' },
      { status: 404 }
    )
  }

  const { id } = await params
  try {
    const run = await getRun(id)
    if (!run) {
      return NextResponse.json({ success: false, error: 'Run not found.' }, { status: 404 })
    }
    return NextResponse.json(
      { success: true, data: run },
      { headers: rateLimitHeaders(rateResult) }
    )
  } catch (err) {
    console.error('Run reload error', err)
    return NextResponse.json(
      { success: false, error: 'Failed to load run.' },
      { status: 500 }
    )
  }
}
