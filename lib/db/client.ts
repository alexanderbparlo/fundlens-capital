import { neon, type NeonQueryFunction } from '@neondatabase/serverless'

// Persistence is optional. The handoff mandates run snapshots from day one, but
// the tool must also run locally with no database. Routes check `isDbConfigured`
// and degrade gracefully: projections still compute, only the snapshot write and
// reload-by-URL are skipped.
export const isDbConfigured = Boolean(process.env.DATABASE_URL)

// Neon's serverless driver opens a fresh HTTP connection per call — safe for
// Vercel functions, no pool to manage.
export const sql: NeonQueryFunction<false, false> | null = isDbConfigured
  ? neon(process.env.DATABASE_URL as string)
  : null
