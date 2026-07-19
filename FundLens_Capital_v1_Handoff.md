# FundLens Capital — v1 Build Handoff

> **Code owns all cash-flow math and scenario arithmetic. Every parameter is
> user-visible and defaulted from documented sources. The LLM's role is confined to
> extraction, narration, and flagging input inconsistencies — it never selects a
> parameter.**

**Target:** Claude Code build session
**Prerequisite skill files to load:** `fundlens-suite.md`, `fund-accounting-domain.md`, `anthropic-api-patterns.md`
**Status:** Net-new tool in the DeciFin / FundLens suite
**Date scoped:** June 2026

---

## 1. What This Tool Is

FundLens Capital is an **LP-side capital cash-flow forecasting tool**. An investor (typically an LP CFO, treasury function, or family-office allocator) uploads their capital account statement / fund terms and receives a forward-looking projection of when capital will be **called** and when **distributions** will arrive over the remaining life of the fund — plus a treasury view of how much committed-but-uncalled capital they need to keep liquid.

### One-line positioning
> **FundLens Forecast tells an LP how the fund will perform. FundLens Capital tells them how to manage their cash around it.** Performance vs. liquidity.

### Why it exists / why it's different
Most of the FundLens suite is GP- or ManCo-facing. Capital is deliberately **LP-facing** — it answers a question the rest of the suite does not: *as this investor, when does my money go out, when does it come back, and how much dry powder do I need on hand?*

### Differentiation from adjacent tools (keep these boundaries crisp)

| Tool | Question it answers | Perspective | Output |
|---|---|---|---|
| **DesoFall / FundLens Waterfall** | How does a *realized* distribution split across tiers? | GP economics | Tier-by-tier allocation, point-in-time |
| **FundLens Forecast** | How will the *fund* perform under scenarios? | Fund-level | NAV / IRR / TVPI value projections |
| **FundLens Capital** | *When* and *how much* cash moves for *this LP*? | LP-level | Dated cash-flow calendar + liquidity view |

Capital sits **downstream** of both: it reuses the Waterfall tier engine to split projected gross proceeds into LP-net distributions, and its distribution-timing logic shares conceptual DNA with Forecast's exit assumptions. But its output — a **dated, LP-specific cash-flow schedule** — is something neither neighbor produces.

---

## 2. Architecture Principle (Non-Negotiable)

**Deterministic-first.** Consistent with the rest of the suite and the FundLens Audit cornerstone finding, the LLM is confined to the two ends of the workflow. Everything in between is pure, unit-testable TypeScript.

```
┌─────────────┐   ┌──────────────┐   ┌─────────────────────┐   ┌──────────────┐
│  EXTRACT    │ → │   CONFIRM    │ → │  PROJECT (pacing)   │ → │  NARRATE     │
│  (LLM)      │   │  (user gate) │   │  (deterministic TS) │   │  (LLM)       │
└─────────────┘   └──────────────┘   └─────────────────────┘   └──────────────┘
   Claude reads      User reviews/        ALL math here is        Claude writes
   the upload,       overrides the        plain TypeScript.       a plain-English
   pre-populates     extracted fields.    No agent touches        summary of the
   known fields.     QC gate — not        a single projected      already-computed
                     skippable.           number.                 schedule.
```

The projection engine must **never** call the model to compute, estimate, or "reason about" a number. If a value is projected, it comes from a deterministic function with explicit inputs. The narrative layer receives the finished schedule as structured data and describes it — it does not generate or alter figures.

---

## 3. Stack & Conventions

Follow `fundlens-suite.md`. Summary:

- **Framework:** Next.js (App Router) + TypeScript
- **Deploy:** Vercel
- **Persistence:** Neon (Postgres) — store run snapshots for reload/regression
- **AI:** Anthropic API per `anthropic-api-patterns.md` — `claude-opus-4` with `thinking: { type: 'adaptive' }` + `output_config: { effort: 'xhigh' }`, PDF document-block ingestion, prompt caching on system prompts, shared client singleton + error handler
- **Charts:** match Forecast's chart components for visual consistency across the suite

---

## 4. v1 Scope — Inputs

### 4.1 Intake
Single fund, single LP. (Multi-fund portfolio aggregation is **v2** — see §8.)

User uploads one or more of: capital account statement, LPA / side-letter terms, prior capital call / distribution notices. PDF and Excel/CSV both supported.

### 4.2 Extract → Confirm fields
Apply the standard suite pattern: the model pre-populates what it can find; the user reviews and corrects on an editable confirmation form; **analysis runs only on confirmed data.** This gate is mandatory and not skippable.

Fields to extract:

| Field | Notes |
|---|---|
| LP commitment | total committed capital for this investor |
| Called to date (ITD) | cumulative capital called from this LP |
| Unfunded commitment (RCC) | derive as `commitment − called` if not explicit |
| Distributions received (ITD) | cumulative distributions to this LP |
| Current capital account balance / NAV | this LP's share of fund NAV |
| Fund vintage / inception date | for fund-age and J-curve positioning |
| Investment period end date | drives the call-pacing horizon |
| Fund term / end date | drives the distribution-pacing horizon |
| Historical call schedule (if present) | dated call amounts — used to fit pacing to actual deployment rhythm |
| Historical distribution schedule (if present) | dated distribution amounts |
| Fund-level economics (hurdle, carry %, GP catch-up) | passed to the Waterfall engine for net-of-carry distribution splits |

**Derivation rules** (deterministic, same spirit as Forecast):
```
if unfunded explicit:      called = commitment − unfunded
elif commitment && called: unfunded = commitment − called
else:                      leave blank, require manual entry
```

---

## 5. v1 Scope — The Pacing Engine (Deterministic Core)

This is the heart of the tool and is **entirely TypeScript**. Two independent projection tracks, each user-overridable per period.

### 5.1 Call-side projection
**Goal:** distribute the remaining unfunded commitment across the quarters until investment-period-end.

- **Default curve:** front-loaded. Calls cluster early in the remaining investment period and taper. Implement as a declining-weight distribution across remaining IP quarters (e.g., linearly or geometrically declining weights, normalized to sum to remaining unfunded).
- **History-fit mode:** if historical call data is present, compute the observed deployment pace (called as % of commitment per quarter, or fit the cumulative-called curve) and project forward at that observed rhythm instead of the generic default.
- **Output:** a dated series of projected calls (cash *out* for the LP), each quarter from as-of date to investment-period-end.

### 5.2 Distribution-side projection
**Goal:** project return of capital + gains to the LP across the remaining fund life, following a J-curve.

- **J-curve shape:** distributions minimal in early fund years, ramping as the portfolio matures and exits occur, tapering toward fund end. Position the curve using fund age (from vintage) and an assumed average hold period.
- **Magnitude basis:** project gross proceeds from current NAV + an assumed total-value multiple on remaining holdings, released across the back half of fund life on the distribution pace curve.
- **Net-of-carry:** run projected gross proceeds through the **Waterfall tier engine** (DesoFall / FundLens Waterfall) so the LP sees distributions *net of GP carry* — return of capital, preferred return, and post-carry profit split. This is the key reuse dependency (see §7).
- **Output:** a dated series of projected distributions (cash *in* for the LP).

### 5.3 Override layer (the "hybrid" requirement)
Every projected period — call and distribution — is **user-overridable**. The model-generated default is a starting point; the user can replace any period with known information (e.g., "GP guidance says a 5% call next quarter"). Overrides persist for the run and feed all downstream outputs.

---

## 6. v1 Scope — Outputs

Four artifacts, all driven off the same deterministic projected schedule.

### 6.1 Dated cash-flow schedule
Quarter-by-quarter table: projected calls (negative), projected distributions (positive), net cash flow, running cumulative called, running cumulative distributed, running net. This is the source-of-truth grid.

### 6.2 J-curve chart
Cumulative net cash flow over time. Shows the trough (peak negative cumulative position) and the crossover point where the LP turns net-positive. Match Forecast's chart styling.

### 6.3 Net liquidity / treasury view  ← the LP-specific differentiator
Reframes the unfunded commitment as a **dated treasury obligation**. For each forward quarter: projected call (liquidity needed), running unfunded balance, projected distribution (liquidity returned), net position. Surface a rolling **"liquidity required over next N quarters"** figure — the practical answer to "how much dry powder do I keep on hand?" This output is the clearest thing neither Forecast nor Waterfall produces; treat it as the marquee feature.

### 6.4 Downloadable forecast table
The full schedule exported as CSV / Excel for the LP to drop into their own treasury models.

### 6.5 AI narrative layer
The model receives the **finished, computed schedule** as structured data and writes a plain-English summary: projected peak funding need and when it occurs, the J-curve crossover timing, the expected pace of capital return, and any notable liquidity pinch points. **It describes; it does not compute.**

---

## 7. Dependency: Waterfall Tier Engine

v1's distribution-side projection requires the waterfall tier logic currently living in **DesoFall** (rename to **FundLens Waterfall** pending — treat the engine as a shared importable module regardless of final name).

- Extract the tier-split logic (return of capital → preferred/hurdle → GP catch-up → carry split) into a reusable function: `splitProceeds(grossProceeds, fundTerms) → { lpNet, gpCarry, breakdown }`.
- FundLens Capital imports this to convert projected **gross** proceeds into LP-**net** distributions.
- If a clean import isn't feasible in this session, stub the interface and flag for follow-up — but the net-of-carry distinction must be in v1, not deferred.

---

## 8. v1 Scope Boundaries (Do NOT Build — surface as "coming in v2")

- **Multi-fund portfolio aggregation** — the "I'm an LP in 12 funds, show me my blended call schedule" view. Compelling and obvious next step, but a different data model. Explicitly deferred.
- **Scenario branching** on the projections (optimistic/base/downside pacing) — v1 is single-path with overrides. Scenario layering is v2 and overlaps Forecast's scenario engine.
- **Tax / character-of-distribution modeling** (ROC vs. capital gain vs. income) — out of scope.
- **Secondary-sale / transfer modeling** — out of scope.
- **GP-side aggregate view** (all LPs at once) — v1 is single-LP. GP rollup is a later consideration.

---

## 9. Suggested Build Order

Confirm each step before proceeding (suite convention).

1. Project scaffold — Next.js + TS + dependencies + file structure per `fundlens-suite.md`
2. File upload handling — PDF document-block + Excel/CSV parsing
3. `/api/capital/extract` route + extraction system prompt
4. Confirmation form UI (editable, field-source labeled) — the QC gate
5. **Deterministic pacing engine** — call-side projection (`callPacing.ts`)
6. **Deterministic pacing engine** — distribution-side projection (`distributionPacing.ts`), importing the Waterfall engine
7. Override layer — per-period editable schedule, state + persistence
8. Outputs — cash-flow schedule grid, J-curve chart, treasury/liquidity view, CSV/Excel export
9. `/api/capital/narrative` route + narrative system prompt (consumes finished schedule)
10. Neon run persistence — snapshot inputs + confirmed figures + projected schedule for reload / regression diffing
11. Polish — client-side routing, results retention on back-navigation, responsive layout

---

## 10. Proposed File Structure

```
app/
  capital/
    page.jsx                      ← main flow: upload → confirm → project → results
  api/
    capital/
      extract/route.js
      narrative/route.js
lib/
  anthropic/
    client.js                     ← shared singleton (likely exists)
    errorHandler.js               ← shared handler (likely exists)
  prompts/
    capitalPrompts.js             ← extraction + narrative system prompts
  capital/
    extractionUtils.ts            ← field extraction + normalization
    callPacing.ts                 ← deterministic call-side projection
    distributionPacing.ts         ← deterministic distribution-side projection
    liquidityView.ts              ← treasury / net-liquidity derivation
    scheduleTypes.ts              ← shared types for the projected schedule
  waterfall/
    splitProceeds.ts              ← imported/extracted from DesoFall/FundLens Waterfall
```

---

## 11. Regression / Test Notes

- Every function in `lib/capital/` is pure and must have unit tests with hand-verified expected values (suite standard).
- Build a synthetic LP fixture (single PE fund, known commitment / called / NAV / vintage / IP-end) and assert the projected schedule against hand-computed values before wiring the UI.
- The Waterfall import must be validated against DesoFall's existing test cases to confirm parity after extraction.
- Persist run snapshots from day one so projection changes can be diffed across builds.
