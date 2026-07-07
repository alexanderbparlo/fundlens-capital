import { APIConnectionError, RateLimitError, APIError } from '@anthropic-ai/sdk'
import { NextResponse } from 'next/server'

// SDK v0.90+ removed APIStatusError — APIError is now the base for all HTTP errors.
// RateLimitError extends APIError, so its check must come first.
export function handleAnthropicError(error) {
  if (error instanceof APIConnectionError) {
    console.error('Anthropic connection error:', error.message)
    return NextResponse.json(
      { success: false, error: 'Connection failed. Please try again.' },
      { status: 503 }
    )
  }

  if (error instanceof RateLimitError) {
    console.error('Anthropic rate limit hit:', error.message)
    return NextResponse.json(
      { success: false, error: 'Rate limit reached. Please wait a moment.' },
      { status: 429 }
    )
  }

  if (error instanceof APIError) {
    console.error('Anthropic API error:', error.status, error.message)
    return NextResponse.json(
      { success: false, error: 'The AI service returned an error. Please try again.' },
      { status: error.status }
    )
  }

  console.error('Unexpected error in Anthropic call:', error)
  return NextResponse.json(
    { success: false, error: 'An unexpected error occurred.' },
    { status: 500 }
  )
}
