import { sql, isDbConfigured } from './client'
import type { CapitalSchedule, ConfirmedFields, LiquidityView, PacingConfig } from '@/lib/capital/scheduleTypes'

// Persistence for capital projection runs. Every function no-ops gracefully when
// the database is not configured — the tool runs fully without it (the handoff
// mandates snapshots, but local dev and previews must not require Neon).

export interface RunSnapshot {
  id: string
  fundName: string | null
  asOfDate: string | null
  confirmedFields: ConfirmedFields
  pacingConfig: PacingConfig
  schedule: CapitalSchedule
  liquidity: LiquidityView
  narrative: string | null
  createdAt: string
}

interface SaveRunInput {
  confirmedFields: ConfirmedFields
  pacingConfig: PacingConfig
  schedule: CapitalSchedule
  liquidity: LiquidityView
  promptVersion: string
  engineVersion: string
}

// Inserts a new run snapshot. Returns the new id, or null when persistence is off.
export async function createRun(input: SaveRunInput): Promise<string | null> {
  if (!isDbConfigured || !sql) return null
  const rows = await sql`
    INSERT INTO capital_runs
      (fund_name, as_of_date, confirmed_fields, pacing_config, schedule_json, liquidity_json, prompt_version, engine_version)
    VALUES
      (${input.confirmedFields.fundName}, ${input.confirmedFields.asOfDate},
       ${JSON.stringify(input.confirmedFields)}, ${JSON.stringify(input.pacingConfig)},
       ${JSON.stringify(input.schedule)}, ${JSON.stringify(input.liquidity)},
       ${input.promptVersion}, ${input.engineVersion})
    RETURNING id
  `
  return rows[0]?.id ?? null
}

// Updates an existing run's projection (used when per-period overrides change).
// Returns true if a row was updated.
export async function updateRun(id: string, input: SaveRunInput): Promise<boolean> {
  if (!isDbConfigured || !sql) return false
  const rows = await sql`
    UPDATE capital_runs SET
      confirmed_fields = ${JSON.stringify(input.confirmedFields)},
      pacing_config    = ${JSON.stringify(input.pacingConfig)},
      schedule_json    = ${JSON.stringify(input.schedule)},
      liquidity_json   = ${JSON.stringify(input.liquidity)},
      engine_version   = ${input.engineVersion}
    WHERE id = ${id}
    RETURNING id
  `
  return rows.length > 0
}

export async function setRunNarrative(id: string, narrative: string): Promise<void> {
  if (!isDbConfigured || !sql) return
  await sql`UPDATE capital_runs SET narrative = ${narrative} WHERE id = ${id}`
}

export async function getRun(id: string): Promise<RunSnapshot | null> {
  if (!isDbConfigured || !sql) return null
  const rows = await sql`SELECT * FROM capital_runs WHERE id = ${id} LIMIT 1`
  const r = rows[0]
  if (!r) return null
  return {
    id: r.id,
    fundName: r.fund_name,
    asOfDate: r.as_of_date,
    confirmedFields: r.confirmed_fields,
    pacingConfig: r.pacing_config,
    schedule: r.schedule_json,
    liquidity: r.liquidity_json,
    narrative: r.narrative,
    createdAt: r.created_at,
  }
}
