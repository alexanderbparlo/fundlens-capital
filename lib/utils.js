import { clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs) {
  return twMerge(clsx(inputs))
}

export function formatCurrency(value, currency = 'USD') {
  if (value === null || value === undefined || Number.isNaN(value)) return '—'
  const symbol = currency === 'EUR' ? '€' : currency === 'GBP' ? '£' : '$'
  const sign = value < 0 ? '-' : ''
  const abs = Math.abs(value)
  if (abs >= 1_000_000_000) return `${sign}${symbol}${(abs / 1_000_000_000).toFixed(2)}B`
  if (abs >= 1_000_000)     return `${sign}${symbol}${(abs / 1_000_000).toFixed(2)}M`
  if (abs >= 1_000)         return `${sign}${symbol}${(abs / 1_000).toFixed(1)}K`
  return `${sign}${symbol}${abs.toFixed(0)}`
}

export function formatPercent(value, decimals = 1) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—'
  return `${(value * 100).toFixed(decimals)}%`
}

export function formatMultiple(value, decimals = 2) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—'
  return `${value.toFixed(decimals)}x`
}

// Quarter label from an ISO date string, e.g. '2026-06-30' → "Q2 2026".
export function formatQuarterLabel(isoDate) {
  if (!isoDate) return '—'
  const d = new Date(isoDate)
  if (Number.isNaN(d.getTime())) return '—'
  const q = Math.floor(d.getUTCMonth() / 3) + 1
  return `Q${q} ${d.getUTCFullYear()}`
}

export function parseJsonResponse(raw) {
  const cleaned = raw
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim()
  return JSON.parse(cleaned)
}

export async function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result
      resolve(result.split(',')[1])
    }
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}
