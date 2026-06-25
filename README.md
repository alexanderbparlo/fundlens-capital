# FundLens Capital

LP-side capital cash-flow forecasting. Upload a capital account statement and fund
terms, and get a forward-looking projection of when capital will be **called**, when
**distributions** will arrive, and how much committed-but-uncalled capital to keep
liquid over the remaining life of the fund.

Part of the FundLens suite. Where FundLens Forecast tells an LP how the fund will
perform, FundLens Capital tells them how to manage their cash around it — performance
vs. liquidity.

## Architecture

Deterministic-first. The LLM is confined to the two ends of the workflow; everything
in between is pure, unit-tested TypeScript.

```
EXTRACT (LLM)  →  CONFIRM (user QC gate)  →  PROJECT (deterministic TS)  →  NARRATE (LLM)
```

The projection engine never calls a model to compute, estimate, or reason about a
number. The narrative layer receives the finished schedule and describes it.

- **Call pacing** — front-loaded declining-weight curve, or history-fit to the observed
  deployment rhythm.
- **Distribution pacing** — NAV grossed up by a forward value multiple, run through a
  whole-fund (European) waterfall for net-of-carry distributions, released on a J-curve.
- **Outputs** — dated cash-flow schedule (editable per period), J-curve chart, net
  liquidity / treasury view with rolling dry-powder figures, CSV/Excel export, and an
  AI narrative.

## Stack

Next.js 16 (App Router) · TypeScript · Tailwind · Recharts · `@anthropic-ai/sdk`
(`claude-opus-4-8`) · Neon/Postgres · Upstash Redis · Vercel.

## Development

```bash
npm install
cp .env.example .env.local   # add ANTHROPIC_API_KEY; DATABASE_URL is optional
npm run db:migrate           # if DATABASE_URL is set — creates the capital_runs table
npm run dev
npm test                     # deterministic engine unit tests
```

Without `DATABASE_URL` the tool runs fully; only run snapshots and reload-by-URL are
disabled.

## Scope (v1)

Single fund, single LP. Multi-fund portfolio aggregation, scenario branching, and
tax-character modeling are planned for v2.
