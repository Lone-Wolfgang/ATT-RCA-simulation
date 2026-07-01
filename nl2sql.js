// netlify/functions/nl2sql.js
// Two modes behind one endpoint:
//
//   mode "query": natural-language question -> ONE read-only SELECT over the
//     live in-browser faults table (frontend runs it with sql.js). Also returns
//     a short natural-language answer describing what was asked for.
//
//   mode "plan": a Hot Spot Action Plan. The frontend has ALREADY computed the
//     plan skeleton deterministically (actionplan.js) — phases, dispatch tags,
//     per-phase site/customer rollups, recalibration flags. This function only
//     writes the prose: a NOC-planner narrative with labor/resource suggestions
//     and the net customer benefit per stage. It must NOT change any numbers.
//
// Holds ANTHROPIC_API_KEY (Netlify env var). Same-origin on Netlify, no CORS.

const MODEL = "claude-opus-4-8";

const SCHEMA = `
CREATE TABLE faults (
  cell_global_id TEXT, fault_class TEXT, latitude REAL, longitude REAL,
  state TEXT, state_name TEXT, region TEXT, nearest_city TEXT,
  population_served INTEGER, impacted_customers INTEGER
);
CREATE TABLE cities (name TEXT, lat REAL, lon REAL);
-- C1 Downtilt too large | C2 Over-shooting | C3 Neighbor serves better
-- C4 Overlapping coverage | C5 Frequent handovers | C6 PCI mod-30 collision
-- C7 High vehicle speed | C8 Too few scheduled RBs
`.trim();

const QUERY_EXAMPLES = `
Q: show me the issues in Dallas and the surrounding area
SQL: SELECT f.* FROM faults f, cities c WHERE c.name = 'Dallas' AND f.latitude BETWEEN c.lat - 0.72 AND c.lat + 0.72 AND f.longitude BETWEEN c.lon - 0.85 AND c.lon + 0.85;
Q: pci collisions in texas
SQL: SELECT * FROM faults WHERE fault_class = 'C6' AND state = 'TX';
Q: the worst 20 faults by customer impact
SQL: SELECT * FROM faults ORDER BY impacted_customers DESC LIMIT 20;
Q: coverage and overshoot problems in the west
SQL: SELECT * FROM faults WHERE fault_class IN ('C1','C2') AND region = 'West';
`.trim();

const QUERY_SYSTEM = `You translate a question about cell-tower network faults into ONE SQLite SELECT, then briefly say what it returns.

Return STRICT JSON only, no markdown: {"sql": "<one SELECT>", "answer": "<one or two plain sentences>"}.

SQL rules:
- A single read-only SELECT. Never DROP/DELETE/UPDATE/INSERT/ALTER/CREATE/ATTACH/PRAGMA.
- Prefer "SELECT f.*" or "SELECT *" from faults so full rows come back.
- For "near"/"around"/"surrounding area" of a city, JOIN cities and use a ~50-mile box: +/- 0.72 latitude, +/- 0.85 longitude around that city's lat/lon.
- State codes are uppercase 2-letter (e.g. 'TX'). Match names as given.
- If unanswerable from these columns: {"sql":"SELECT * FROM faults WHERE 1=0;","answer":"I couldn't map that to the available fault data."}

The "answer" is a short, plain description of what the filter shows (no SQL jargon).

Schema:
${SCHEMA}

Examples:
${QUERY_EXAMPLES}`;

const PLAN_SYSTEM = `You are a NOC (Network Operations Center) planning assistant for a cell-tower fault-triage tool.

You will be given an ALREADY-COMPUTED action plan for a geographic hot spot: its phases, the sites in each, dispatch type, per-phase customer-impact totals, and recalibration flags. The structure and every number are FIXED and correct — DO NOT change, recompute, reorder, or re-bucket anything. Narrate it.

Write a TERSE operational plan. Hard limits:
1. One short framing sentence (place + total sites + total customers impacted + how many sites need field dispatch).
2. Then, for each phase IN THE ORDER GIVEN: ONE or at most TWO sentences. Name the work (informed by the fault classes), the labor/resource (Phase 1 = field crew / truck roll; Phases 2-3 = remote NOC engineer, no dispatch), and the net benefit as that phase's customer number. If a phase is flagged "recalibrate after Phase 1", say it must wait until post-dispatch re-measurement — in the same one/two sentences, not extra lines.
3. One closing sentence on sequencing: batch the field dispatch first, let remote tuning cascade.

Rules:
- Use the EXACT customer numbers and site counts given. Never invent numbers.
- Be compact and skimmable. No preamble, no '#' headers. A short **bold** phase label at the start of each phase's sentence is fine.
- Measure benefit in CUSTOMERS.`;

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "Use POST." });

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return json(500, { error: "Server is missing ANTHROPIC_API_KEY." });

  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch { return json(400, { error: "Body must be JSON." }); }

  const mode = body.mode === "plan" ? "plan" : "query";

  try {
    if (mode === "plan") return await handlePlan(body, key);
    return await handleQuery(body, key);
  } catch (e) {
    return json(502, { error: "Request failed.", detail: String(e) });
  }
};

async function handleQuery(body, key) {
  const question = (body.question || "").trim();
  if (!question) return json(400, { error: "Ask a question." });

  const data = await callAnthropic(key, {
    system: QUERY_SYSTEM,
    max_tokens: 500,
    messages: [{ role: "user", content: question }],
  });
  if (data.error) return json(502, data);

  const text = extractText(data);
  const parsed = safeJson(text);
  let sql = (parsed?.sql || "").trim();
  const answer = (parsed?.answer || "").trim();
  sql = cleanSql(sql);

  if (!isSelectOnly(sql)) {
    return json(422, { error: "Could not form a safe read-only query.", sql });
  }
  return json(200, { sql, answer });
}

async function handlePlan(body, key) {
  const skeleton = (body.plan || "").trim();
  const place = (body.place || "").trim();
  if (!skeleton) return json(400, { error: "Missing plan skeleton." });

  const user =
    `Hot spot: ${place || "(unnamed)"}\n\n` +
    `Here is the computed action plan. Narrate it per your instructions; keep all numbers exactly:\n\n` +
    skeleton;

  const data = await callAnthropic(key, {
    system: PLAN_SYSTEM,
    max_tokens: 900,
    messages: [{ role: "user", content: user }],
  });
  if (data.error) return json(502, data);

  const plan = extractText(data).trim();
  return json(200, { plan });
}

// ---- Anthropic call ----
async function callAnthropic(key, payload) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({ model: MODEL, ...payload }),
  });
  if (!r.ok) {
    return { error: "Upstream model error.", detail: await r.text() };
  }
  return r.json();
}

function extractText(data) {
  return (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}

// ---- SQL helpers ----
function safeJson(text) {
  let s = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  try { return JSON.parse(s); } catch {}
  const m = s.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}
function cleanSql(sql) {
  let s = (sql || "").replace(/```sql/gi, "").replace(/```/g, "").trim();
  const m = s.match(/select[\s\S]*/i);
  if (m) s = m[0];
  const semi = s.indexOf(";");
  if (semi !== -1) s = s.slice(0, semi + 1);
  return s.trim();
}
function isSelectOnly(sql) {
  if (!sql) return false;
  const upper = sql.toUpperCase();
  if (!upper.trimStart().startsWith("SELECT")) return false;
  if (/\b(DROP|DELETE|UPDATE|INSERT|ALTER|CREATE|ATTACH|DETACH|PRAGMA|REPLACE|VACUUM)\b/.test(upper)) return false;
  if (sql.replace(/;\s*$/, "").includes(";")) return false;
  return true;
}
function json(statusCode, obj) {
  return { statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(obj) };
}
