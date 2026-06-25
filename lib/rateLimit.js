if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
  console.warn(
    '[rateLimit] Upstash Redis is not configured. Rate limiting is in-memory and per-process — ' +
    'not effective in distributed or serverless deployments. Set UPSTASH_REDIS_REST_URL and ' +
    'UPSTASH_REDIS_REST_TOKEN for production use.'
  )
}

export const RATE_LIMITS = {
  extract:   { limit: 10, windowMs: 60 * 60 * 1000 }, // LLM document ingestion — expensive
  project:   { limit: 60, windowMs: 60 * 60 * 1000 }, // deterministic — cheap, recomputed on every override
  narrative: { limit: 30, windowMs: 60 * 60 * 1000 }, // LLM, text-only
  run:       { limit: 60, windowMs: 60 * 60 * 1000 }, // snapshot reload — read-only
}

const memoryStore = new Map()

function checkMemoryRateLimit(key, limit, windowMs) {
  const now = Date.now()
  const record = memoryStore.get(key)

  if (!record || now > record.resetAt) {
    memoryStore.set(key, { count: 1, resetAt: now + windowMs })
    return { success: true, remaining: limit - 1, reset: now + windowMs }
  }

  if (record.count >= limit) {
    return { success: false, remaining: 0, reset: record.resetAt }
  }

  record.count++
  return { success: true, remaining: limit - record.count, reset: record.resetAt }
}

export function getClientIdentifier(request) {
  const fwd = request.headers.get('x-forwarded-for')
  if (fwd) return fwd.split(',')[0].trim()
  const real = request.headers.get('x-real-ip')
  if (real) return real.trim()
  return 'unknown'
}

export async function checkRateLimit(route, identifier = 'unknown') {
  const config = RATE_LIMITS[route]
  const key = `fundlens-capital:${route}:${identifier}`

  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    try {
      const { Ratelimit } = await import('@upstash/ratelimit')
      const { Redis } = await import('@upstash/redis')

      const redis = new Redis({
        url: process.env.UPSTASH_REDIS_REST_URL,
        token: process.env.UPSTASH_REDIS_REST_TOKEN,
      })

      const ratelimit = new Ratelimit({
        redis,
        limiter: Ratelimit.slidingWindow(config.limit, `${config.windowMs}ms`),
        analytics: false,
      })

      const result = await ratelimit.limit(key)
      return { success: result.success, remaining: result.remaining, reset: result.reset }
    } catch (err) {
      console.warn('Upstash rate limit error, falling back to memory:', err)
    }
  }

  return checkMemoryRateLimit(key, config.limit, config.windowMs)
}

export function rateLimitHeaders(result) {
  return {
    'X-RateLimit-Remaining': String(result.remaining),
    'X-RateLimit-Reset':     String(result.reset),
  }
}
