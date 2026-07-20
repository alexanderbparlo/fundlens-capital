// Pure calendar-quarter helpers. All arithmetic in UTC to stay timezone-stable.

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

// Last calendar day of the quarter (qIdx 0..3 → Mar/Jun/Sep/Dec).
function quarterEndForIndex(year: number, qIdx: number): Date {
  const endMonth = qIdx * 3 + 2 // 2, 5, 8, 11
  // Day 0 of the following month is the last day of endMonth.
  return new Date(Date.UTC(year, endMonth + 1, 0))
}

// The quarter-end on or after the given date's own quarter.
export function quarterEndOf(date: Date): Date {
  return quarterEndForIndex(date.getUTCFullYear(), Math.floor(date.getUTCMonth() / 3))
}

// ISO quarter-end of the given ISO date. This is the single horizon derivation for
// the distribution grid AND the preferred-accrual tail (round 3, Item 2): the grid
// has always run through the quarter-end containing fundEndDate, so the accrual must
// stop there too — one derivation, two consumers. Do not pass a raw fundEndDate as
// an accrual endpoint anywhere.
export function quarterEndIso(iso: string): string {
  return isoDate(quarterEndOf(new Date(iso)))
}

// "Q3 2026" label for an ISO date.
export function quarterLabel(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const q = Math.floor(d.getUTCMonth() / 3) + 1
  return `Q${q} ${d.getUTCFullYear()}`
}

// All quarter-end ISO dates strictly after `asOf`, through the quarter that
// contains `end` (inclusive). Returns [] if `end` is on/before `asOf`.
export function enumerateQuarterEnds(asOf: string, end: string): string[] {
  const a = new Date(asOf)
  const horizon = quarterEndOf(new Date(end))
  if (horizon.getTime() <= a.getTime()) return []

  const out: string[] = []
  let year = a.getUTCFullYear()
  let q = Math.floor(a.getUTCMonth() / 3)

  // Advance to the first quarter-end strictly after asOf.
  let qe = quarterEndForIndex(year, q)
  while (qe.getTime() <= a.getTime()) {
    q++
    if (q > 3) { q = 0; year++ }
    qe = quarterEndForIndex(year, q)
  }

  while (qe.getTime() <= horizon.getTime()) {
    out.push(isoDate(qe))
    q++
    if (q > 3) { q = 0; year++ }
    qe = quarterEndForIndex(year, q)
  }

  return out
}

// Whole-and-fractional years between two ISO dates (b - a). Negative if b < a.
export function yearsBetween(a: string, b: string): number {
  const ms = new Date(b).getTime() - new Date(a).getTime()
  return ms / (365.25 * 24 * 60 * 60 * 1000)
}

// Count of distinct calendar quarters present in a set of ISO dates.
export function distinctQuarterCount(dates: string[]): number {
  const keys = new Set<string>()
  for (const iso of dates) {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) continue
    keys.add(`${d.getUTCFullYear()}-${Math.floor(d.getUTCMonth() / 3)}`)
  }
  return keys.size
}
