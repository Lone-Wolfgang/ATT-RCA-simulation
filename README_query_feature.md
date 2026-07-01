# Ask the Map + Hot Spot Action Plan

One left-sidebar panel, two entry points, both backed by the model.

## 1. Typed query (NL → filter + chart + answer)

Type a plain-English question. `netlify/functions/nl2sql.js` (mode `query`)
returns one read-only `SELECT` **and** a one-line plain answer. `query.js` runs
the SELECT client-side with sql.js against a DB built from the **live** faults,
then the map dims non-matches, fits bounds, and a stacked bar shows the
root-cause blend. The model's answer prints above the bar.

Examples: *"issues near Dallas"*, *"PCI collisions in Texas"*,
*"worst 20 by impact"*.

## 2. Hot spot click (→ action plan)

Click a hot spot row. The affected towers (already computed by
`detectHotspots`, now carrying their member faults) are turned into a phased
**Action Plan**:

- **Phase 1 Coverage & Geometry** (C1, C2) — 🚚 field dispatch / truck roll
- **Phase 2 Interference & Mobility** (C4, C6, C5, C3) — 📡 remote / NOC
- **Phase 3 Throughput & Validation** (C8, C7) — 📡 remote / NOC

No SQL is used here — the towers are already in hand.

### Structure is computed in code; only the prose is the model's

`actionplan.js` deterministically builds the skeleton per
`action-plan-feature.md`: the class→phase map, within-phase sort by impacted
customers, per-phase site/customer rollups, the "sites requiring dispatch"
count (Phase 1 only), and the recalibration flag (any Phase 2/3 item is flagged
*"recalibrate after Phase 1"* iff the hot spot also has a Phase 1 fault). Those
numbers can never drift or hallucinate — they match every other panel.

The skeleton renders immediately (phase cards). Then `nl2sql.js` (mode `plan`)
is given that skeleton and writes the **operational narrative**: labor/resources
per stage (field crew + climb/tilt gear for Phase 1; remote NOC engineer for
Phases 2–3), net customer benefit per phase, and the sequencing logic (batch the
one dispatch first, let remote tuning cascade). The model is instructed never to
change the numbers.

## Why the query DB is built in-browser, not baked in ETL

Faults aren't in `pool.json` — they're resampled in-browser on every Resample,
and `impacted_customers` shifts with the severity dials. A static `towers.sqlite`
would query the pool, not the live faults. So `query.js` rebuilds a tiny
in-memory SQLite from `faultsInView()` whenever the fault set changes (resample,
class filter, drill, dial, severity). An open query or plan clears when the
underlying set changes, so nothing stale lingers.

## Deploy (Netlify)

1. Push to GitHub.
2. Netlify → Import from Git → pick the repo (`netlify.toml` sets publish `.`
   and the functions dir).
3. Site settings → Environment variables → `ANTHROPIC_API_KEY = sk-ant-...`.
4. Deploy. Dashboard at root; function at `/.netlify/functions/nl2sql`.

Local: `netlify dev`.

## Files

- `actionplan.js` — deterministic plan builder (class→phase, rollups, recal flag).
- `query.js` — sql.js load, live-fault DB, SELECT guard, run flow.
- `netlify/functions/nl2sql.js` — router: `query` (NL→SQL+answer) and `plan`
  (skeleton→prose). Holds the key.
- `index.html` — panel markup/CSS, hotspot members capture, plan render + wiring.
- `netlify.toml` — publish root + functions dir.

## Tuning

- **Model**: `MODEL` in `nl2sql.js`.
- **C3 placement**: currently Phase 2 (by-cure), per the spec's default. To move
  it to Phase 3 (by-symptom), change `C3: 2` → `C3: 3` in `actionplan.js`.
- **Action verbs**: `CLASS_ACTION` in `actionplan.js`.
- **Spatial radius**: ~50-mile box (`±0.72` lat / `±0.85` lon) in the query
  examples in `nl2sql.js`.
