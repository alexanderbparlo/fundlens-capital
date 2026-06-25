-- FundLens Capital — Neon (Postgres) schema
-- Run once against your Neon project after DATABASE_URL is set: `npm run db:migrate`.
-- Connection handling is via @neondatabase/serverless (HTTP, no pool).

-- ── Capital runs ──────────────────────────────────────────────────────────────
-- One row per projection run. Anonymous (the suite is open-access), retrieved by
-- opaque id — same model as FundLens Audit's job ids. Stores the QC-gated inputs,
-- the pacing config + per-period overrides, and the full computed schedule so that
-- projection changes can be diffed across builds (handoff §11 regression note).

CREATE TABLE IF NOT EXISTS capital_runs (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  fund_name         TEXT,
  as_of_date        DATE,
  confirmed_fields  JSONB       NOT NULL,   -- ConfirmedFields — source of truth
  pacing_config     JSONB       NOT NULL,   -- curve choices + per-period overrides
  schedule_json     JSONB       NOT NULL,   -- full CapitalSchedule (dated grid + cumulatives)
  liquidity_json    JSONB       NOT NULL,   -- LiquidityView (treasury / dry-powder)
  narrative         TEXT,                   -- null until the narrate step completes
  prompt_version    TEXT        NOT NULL,   -- extraction/narrative prompt semver
  engine_version    TEXT        NOT NULL,   -- pacing-engine semver — for projection diffing
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_capital_runs_fund ON capital_runs (fund_name);
CREATE INDEX IF NOT EXISTS idx_capital_runs_created ON capital_runs (created_at DESC);
