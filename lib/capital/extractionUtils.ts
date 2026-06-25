// Deterministic field derivation for the called / unfunded / commitment triangle,
// per the handoff derivation rules. Pure and unit-tested; the extract route applies
// this after the model returns so any field the model missed is filled consistently.

export interface CapitalTriangle {
  commitment: number | null
  calledToDate: number | null
  unfundedCommitment: number | null
}

export interface DerivationResult extends CapitalTriangle {
  derived: Array<keyof CapitalTriangle> // fields this function computed
}

const isNum = (v: number | null | undefined): v is number =>
  typeof v === 'number' && Number.isFinite(v)

// Rules (deterministic, same spirit as Forecast):
//   if unfunded explicit:        called   = commitment − unfunded
//   elif commitment && called:   unfunded = commitment − called
//   else:                        leave blank, require manual entry
export function deriveCapitalFields(input: CapitalTriangle): DerivationResult {
  const result: DerivationResult = {
    commitment: input.commitment ?? null,
    calledToDate: input.calledToDate ?? null,
    unfundedCommitment: input.unfundedCommitment ?? null,
    derived: [],
  }

  if (isNum(result.commitment) && isNum(result.unfundedCommitment) && !isNum(result.calledToDate)) {
    result.calledToDate = result.commitment - result.unfundedCommitment
    result.derived.push('calledToDate')
  } else if (isNum(result.commitment) && isNum(result.calledToDate) && !isNum(result.unfundedCommitment)) {
    result.unfundedCommitment = result.commitment - result.calledToDate
    result.derived.push('unfundedCommitment')
  }

  return result
}

// Normalize a signed cash-flow magnitude to a non-negative number. Statements may
// present calls/distributions as negatives; the engine works in positive magnitudes.
export function normalizeMagnitude(value: number | null | undefined): number | null {
  if (!isNum(value)) return null
  return Math.abs(value)
}
