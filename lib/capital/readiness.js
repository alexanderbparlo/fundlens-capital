// Projection-readiness check shared by the UI. Mirrors the server-side validation
// in /api/capital/project so the confirm gate can block before a round trip and
// tell the user exactly which required inputs are still missing.

const isNum = v => typeof v === 'number' && Number.isFinite(v)

const REQUIRED_NUMBERS = [
  ['commitment', 'Commitment'],
  ['calledToDate', 'Called to date'],
  ['unfundedCommitment', 'Unfunded commitment'],
  ['distributionsToDate', 'Distributions to date'],
  ['currentNav', 'Current NAV'],
]

// Returns an array of human labels for the required fields still missing.
// Empty array means the inputs are sufficient to project.
export function requiredFieldGaps(fields) {
  if (!fields || typeof fields !== 'object') return ['All fields']
  const gaps = []

  if (!fields.asOfDate) gaps.push('As-of date')
  if (!fields.investmentPeriodEndDate && !fields.fundEndDate) {
    gaps.push('Investment-period-end or fund-end date')
  }
  for (const [key, label] of REQUIRED_NUMBERS) {
    if (!isNum(fields[key])) gaps.push(label)
  }
  const terms = fields.fundTerms ?? {}
  if (!isNum(terms.hurdleRate)) gaps.push('Hurdle rate')
  if (!isNum(terms.carryRate)) gaps.push('Carried interest')

  return gaps
}
