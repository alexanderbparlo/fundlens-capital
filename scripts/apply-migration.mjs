// Applies lib/db/schema.sql to the Neon database in DATABASE_URL.
// Usage: npm run db:migrate   (after setting DATABASE_URL in .env.local)
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { neon } from '@neondatabase/serverless'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Load .env.local if present (no dependency on dotenv).
try {
  const env = readFileSync(resolve(__dirname, '../.env.local'), 'utf8')
  for (const line of env.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
} catch {
  // no .env.local — rely on the ambient environment
}

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Add it to .env.local or the environment.')
  process.exit(1)
}

const schema = readFileSync(resolve(__dirname, '../lib/db/schema.sql'), 'utf8')
const sql = neon(process.env.DATABASE_URL)

// Strip line comments first, then split on statement boundaries (the schema is
// plain DDL with no embedded semicolons).
const statements = schema
  .split('\n')
  .filter(line => !line.trim().startsWith('--'))
  .join('\n')
  .split(';')
  .map(s => s.trim())
  .filter(Boolean)

// This neon http driver only supports the tagged-template call form, so run each
// statement by passing a faux TemplateStringsArray (no params → raw DDL executes).
const exec = q => sql(Object.assign([q], { raw: [q] }))

console.log(`Applying ${statements.length} statement(s) to Neon…`)
for (const statement of statements) {
  await exec(statement)
}
console.log('✓ Migration complete.')
