# Roofing CRM: solution notes

This document describes the solution. The assignment spec is in [`README.md`](README.md) and is unchanged.

The CRM is a map-first lead tool for one county (default **Travis County, TX**). It reads a read-only
property/permit **snapshot** exported by the sibling data pipeline. Sales users can:

- find aged roofs and long-open roofing permits around a GPS position or a dropped pin;
- open property, permit and contractor detail, including provenance;
- turn matches into CRM leads;
- ask a RAG agent natural-language questions such as "open roofing permits older than five years within five
  miles of Pflugerville".

> **Scope:** this is a one-day deliverable, deployed to AWS us-east-2 against the real Travis County snapshot.

**Hosted runtime:**

| What        | URL                                                    |
| ----------- | ------------------------------------------------------ |
| CRM web app | https://d26rjyxj7knih8.cloudfront.net                  |
| tRPC API    | https://8s9hw4zjlc.execute-api.us-east-2.amazonaws.com |

The API reads pipeline snapshot `run-20261015T060821Z` (root `bafybeiawnfo4kvfsjwusazr3cjti53zqcowubwmlw7njbq6fxytnn2ijqm`) from IPFS through `ipfs.filebase.io`; leads are stored in DynamoDB.

---

## 1. Architecture

```
                         ┌────────────────────────── Turborepo (pnpm workspaces) ──────────────────────────┐
                         │                                                                                  │
 Browser ── HTTPS ──▶ CloudFront ──▶ S3 (apps/web build + config.json{apiUrl})                              │
    │                                                                                                       │
    └──── tRPC over HTTPS (httpBatchLink, packages/api-client) ──▶ API Gateway HTTP API  /trpc/{proxy+}     │
                                                                        │                                   │
                                                                        ▼                                   │
                                     Lambda (Node 22, x86_64)  apps/api/src/handler.ts                      │
                                     ├─ tRPC routers: meta, properties, permits, contractors, leads, agent  │
                                     ├─ SnapshotStore: in-process DuckDB (@duckdb/node-api)                 │
                                     │     reads  CRM_DATA_BASE_URL/tables/*.parquet (+ schema/run json)    │
                                     │     httpfs for https (IPFS gateway), fts (BM25) for permit text      │
                                     ├─ LeadRepository → DynamoDB (leads table, GSI byStatus)               │
                                     ├─ RoofingAgent → Vercel AI SDK ToolLoopAgent → Amazon Bedrock         │
                                     └─ Powertools Logger / Tracer (X-Ray) / Metrics (EMF)                  │
                         └──────────────────────────────────────────────────────────────────────────────────┘
 Snapshot source: ../oracle-property-intelligence-platform-pipeline-travis-tx/data/exports/<runId>/
                  or https://ipfs.io/ipfs/<rootCid>  (same layout; never written by the CRM)
```

### Repository layout

```
apps/
  api/            tRPC backend. src/handler.ts = Lambda entry, src/dev-server.ts = local server (same router)
    src/routers/  meta.ts properties.ts permits.ts contractors.ts leads.ts agent.ts index.ts (AppRouter)
    src/data/     source.ts (snapshot location, json), columns.ts (column contract), snapshot.ts (DuckDB queries)
    src/leads/    repository.ts (interface) memory.ts file.ts dynamo.ts service.ts (use cases)
    src/agent/    agent.ts (ToolLoopAgent + tools) retrieval.ts (tool logic + evidence) planner.ts (no-LLM mode) model.ts
    test/         vitest: snapshot queries, leads (memory/file/DynamoDB mock), agent (AI SDK mock model), Lambda handler
    scripts/      smoke.ts: end-to-end check against a running API
  web/            React 19 + Vite + MapLibre GL (OpenFreeMap basemap, no key)
packages/
  shared/         zod schemas (API contract), lead scoring/signals, geo math (haversine, bbox, circle), constants
  api-client/     the single typed tRPC client (vanilla + React hooks) used by every frontend
  tsconfig/       shared TS configs
infra/            CDK app (TypeScript): RoofingCrmApi + RoofingCrmWeb stacks, us-east-2
.github/workflows/ci.yml
```

### Frontend/backend boundary decisions

- **Every query runs server-side.** The browser never touches parquet or DuckDB. It sends typed filter
  objects; the zod schemas for them live in `packages/shared` and are reused as the tRPC input validators.
- **Lead facts come from the snapshot, not the client.** `leads.create` takes only `{propId, permitNumber?}`.
  The server reads the address, owner, roof-age basis, open-permit stats and run id from the snapshot and
  copies them onto the lead. Leads therefore stay readable after the snapshot changes, and a client cannot
  forge facts.
- **One lead per property.** The lead id is `lead_<prop_id>`, and DynamoDB writes it with a conditional put.
  Creating a lead twice is idempotent: a second create from another permit adds that permit number to the
  existing lead.
- **Lead logic is shared and defined once.** Priority, score and reasons are computed in `packages/shared/src/leads.ts`.
  The SQL ordering mirrors the same formula, and a unit test covers it.

## 2. Data contract

`CRM_DATA_BASE_URL` points at one exported run, `data/exports/<runId>/`. It can be a local directory
(absolute, or relative to this repo) or an https root such as `https://ipfs.io/ipfs/<rootCid>`. If a local
path points at the `exports/` directory itself, the latest run directory is used. For https, DuckDB loads
`httpfs` and reads the parquet files with range requests.

| Table read                               | Used for                                                                                                     |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `tables/property_leads.parquet`          | map points, radius/aged-roof/open-permit filters, detail (owner, mailing, roof basis + evidence, provenance) |
| `tables/roofing_permits.parquet`         | permit list and detail, contractor names, BBB columns, BM25 text index, agent tools                          |
| `tables/contractors.parquet`             | contractor card (name variants, phones, trades, taxpayer link, `bbb_id`)                                     |
| `tables/bbb_profiles.parquet`            | BBB rating when linked. The table is currently empty, so the UI shows "BBB rating not available"             |
| `tables/geo_places.parquet`              | geocoding "near [city]" for the agent (exact plus Jaro-Winkler fuzzy match on Census names)                  |
| `run.json`, `schema.json`, `tables.json` | run id, as-of date, per-source limitations, authoritative column list, file paths                            |

**`schema.json` is authoritative.** `apps/api/src/data/columns.ts` lists every column the CRM reads, together
with its normalized type. When the snapshot does not contain a listed column, it is projected as `NULL` and
reported under "Data notes" in the UI and in `meta.snapshot.limitations`. A pipeline schema change therefore
degrades the CRM instead of breaking it. A missing _required_ column (`prop_id`, `latitude`, `longitude`,
`permit_number`) fails at startup with a clear error.

**Radius queries** use a bounding-box prefilter on `latitude`/`longitude`, then an exact haversine predicate
in SQL (`2·R·asin(√(sin²(Δφ/2)+cos φ1 cos φ2 sin²(Δλ/2)))`, R = 3958.76 mi). If a roofing permit has no
coordinates of its own, it inherits the coordinates of its linked parcel.

**Modes:**

- `CRM_DATA_MODE=materialize` (local default) loads `property_leads` into in-memory DuckDB at startup.
- `view` queries the parquet in place. Lambda defaults to `view` to keep cold starts small.

`roofing_permits`, `contractors`, `bbb_profiles` and `geo_places` are always materialized, because they are
small and full-text search (FTS) needs a table.

## 3. Acceptance criteria: how each is met

| README acceptance criterion                                           | Implementation                                                                                                                                                                                                                                                                                                                    |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Default to a county; explore the user's selected area                 | `meta.config` serves the county (`CRM_COUNTY_*`, default Travis 48453). The map opens framed on the county extent. Pan/zoom freely; the search follows the pin.                                                                                                                                                                   |
| Center on GPS and/or a dropped pin                                    | "Use my GPS location" (`navigator.geolocation`). Clicking the map drops the pin; the pin is also draggable. The panel shows the center source (default/GPS/pin/agent) and its coordinates.                                                                                                                                        |
| Configurable search radius                                            | Slider (0.25 to 25 mi) plus a numeric input (up to 50 mi). The radius ring is drawn on the map, and the map refits to it.                                                                                                                                                                                                         |
| Roofs older than a configurable threshold (default 15)                | "Roof older than (years)" input. The default comes from `CRM_ROOF_AGE_THRESHOLD_YEARS=15`. The filter uses `roof_age_years >= threshold`. Each row's roof-age basis is shown, and "(est.)" marks roofs whose age comes from year built.                                                                                           |
| Open roofing permits, emphasizing long-open ones                      | Match mode "open roofing permit" and a "permit open at least N years" filter. Long-open permits (≥ `CRM_LONG_OPEN_PERMIT_DAYS`, default 365) are red on the map, high priority, and red in the lists. Lists sort by open duration, and so does the "Roofing permits" tab.                                                         |
| Permit details: status, open duration, contractor, BBB when available | The detail panel shows each permit's status, open duration, applied/issued/status/completed dates, expired-without-final flag, valuation and contractor (name, phone, trades, taxpayer link). The BBB badge shows the rating when a profile is linked and "BBB rating not available" (with the reason) otherwise.                 |
| Browsable list of candidates from the map/radius filters              | The "Lead properties" tab lists the same query that feeds the map: sortable by priority, roof age, oldest open permit and distance, up to 2,000 rows with a "narrow the radius" hint. The "Roofing permits" tab can be filtered by status (multi-select).                                                                         |
| Create and manage CRM lead records                                    | "+ Lead" appears on list rows, the detail panel, each permit and agent results. The "CRM leads" tab supports a status filter, inline status changes (new/contacted/qualified/won/lost), notes, delete and "Map" (reopen the property). Storage is DynamoDB in AWS and a JSON file locally, behind one `LeadRepository` interface. |
| RAG-backed agent for natural-language questions                       | "Ask the agent" tab plus `agent.ask`. Section 4 covers the design.                                                                                                                                                                                                                                                                |
| Ingestion out of scope; consume existing datasets                     | The CRM only reads the pipeline snapshot through `CRM_DATA_BASE_URL`. It writes nothing back to it.                                                                                                                                                                                                                               |
| Disabled sections for future expansion                                | Outreach campaigns, Estimates & quotes, Insurance claims, Crew scheduling and Analytics appear in the top nav, visibly disabled with a lock icon and a tooltip. "Send outreach" on the leads page is also disabled, because messaging is out of scope. A test asserts that these sections are disabled.                           |

### Demo transcript walkthrough

1. **Open the CRM on a county.** The header reads "Travis County, TX" and the map frames the county. The snapshot
   run id and as-of date sit top right, and "Data notes" lists the snapshot limitations (BBB pending and others).
2. **Drop a pin or use GPS, then set the radius.** Click the map, drag the pin, or press "Use my GPS location".
   Then move the radius slider.
3. **Roofs older than the threshold.** Set the match mode to "Aged roof only" and keep the threshold at 15
   (or change it). The blue points and the list update, and the "In this radius" panel shows the counts.
4. **Long-open permits.** Set "Open roofing permit only", sort by "Oldest open permit", or pick "Permit open
   at least 5+ years". Long-open permits are red.
5. **Open a property or permit.** Click a point or a row. The panel shows roof age, basis and evidence, owner
   and mailing address, every roofing permit with its status and open duration, the contractor card with its
   BBB status, and provenance (parcel source URL, collected_at, sha256, run id).
6. **Convert matches into leads.** Press "+ Lead" on rows or permits, then open "CRM leads" to change status
   and add notes.
7. **Ask the agent.** Example: "Show me open roofing permits older than five years within five miles of
   Pflugerville". The answer comes with its assumptions, missing data, citations (permit numbers and links)
   and result tables, and each result has "Map" and "+ Lead" buttons.
8. **Filter leads** by roof age, permit status and open duration, and radius in the left panel. In "CRM leads",
   filter by lead status.
9. **Future sections:** the locked items in the top nav.

## 4. Agent / RAG design

Most questions are about _structured_ facts (distance, years open, roof age), so retrieval is tool-based and
runs over the same DuckDB snapshot:

| Tool (zod input)                            | Retrieval                                                                                                                                                                                                                                             |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `geocode_place`                             | Census place centroid from `geo_places`: exact match, then Jaro-Winkler ≥ 0.88                                                                                                                                                                        |
| `search_roofing_permits`                    | Radius, open-only, minimum open days and status filters, sorted by open duration                                                                                                                                                                      |
| `search_lead_properties`                    | Radius plus aged-roof/open-permit match mode, sorted by lead priority                                                                                                                                                                                 |
| `search_permit_text`                        | **BM25** (DuckDB `fts`) over permit description, contractor names, address, class and status, optionally within a radius. With `CRM_EMBEDDINGS=bedrock-titan`, the BM25 candidates are re-ranked by Titan embedding cosine similarity (hybrid score). |
| `get_property_details`, `get_snapshot_info` | Detail and limitations                                                                                                                                                                                                                                |

- **LLM:** Vercel AI SDK `ToolLoopAgent` with typed zod tools and no `any`. The provider is set by
  `LLM_PROVIDER`: `bedrock` (default, `@ai-sdk/amazon-bedrock`, credential provider chain, us-east-2,
  wrapped with Bedrock prompt-cache middleware), `anthropic` or `openai`. The loop is capped by
  `LLM_MAX_STEPS` and `LLM_TIMEOUT_MS`.
- **Grounding and citations:** every row a tool returns goes into an `EvidenceCollector`. Citations in the
  answer are _validated_ against it: only permit numbers and prop ids that the tools actually retrieved are
  cited, each with its `permit_link`/`source_url` or parcel source. Assumptions (place resolution,
  day/year conversions, default radius, roof age inferred from year built) and missing data (BBB unavailable,
  no deed date for a property, missing contractor) are recorded by the tools themselves, so the agent does not depend on
  the model to report them. The UI shows the cited rows with "Map" and "+ Lead" actions.
- **No-LLM / failure mode:** with `LLM_PROVIDER=none`, a deterministic planner parses the question (radius,
  years/months/days, place, quoted text, permit vs roof intent) and runs the _same_ tools. It is also the
  fallback when the LLM call fails or times out, which follows the synchronous-external-call rule: bounded
  timeout plus a documented fallback.
- **Tests** use the AI SDK `MockLanguageModelV4` (`ai/test`), so no keys are needed. They script tool calls,
  then check retrieval, citation validation (a made-up id is not cited), assumptions, gaps and the fallback.

**Deviation from `build-rag-systems` (OpenSearch):** the corpus is a read-only, versioned pipeline snapshot,
and the brief forbids ingestion. A separate OpenSearch index would be an ingestion pipeline, plus a second
source of truth that can drift from the snapshot. DuckDB's BM25 index is built from the snapshot at startup,
so it always matches the run being served. If free-text questions become the main use case, the migration path
is to keep the `search_permit_text` tool contract and point it at an OpenSearch hybrid index that the pipeline
builds per run.

## 5. Local development

Prerequisites: Node ≥ 22 and pnpm via corepack (`corepack enable`). The workspace uses pnpm, and Turborepo
and CDK bundling call `pnpm`.

```bash
corepack enable
pnpm install
cp .env.example .env          # optional; set CRM_DATA_BASE_URL / LLM_PROVIDER
npm run dev                   # same as pnpm dev: API on :4000 and web on :5173
```

- If `CRM_DATA_BASE_URL` is unset, the dev server uses `../oracle-property-intelligence-platform-pipeline-travis-tx/data/exports`
  (the latest run). This fallback is for local dev only; the Lambda never uses it.
- Leads are stored in `apps/api/.data/leads.json` (`CRM_LEADS_STORE=file`).
- Without AWS credentials, set `LLM_PROVIDER=none` for retrieval-only agent answers. With the default
  `bedrock`, a failing call falls back to retrieval-only automatically.
- Smoke test against the running API: `pnpm --filter @roofing-crm/api smoke`.

Quality gates (also run in CI): `pnpm format:check`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`,
`pnpm synth`.

## 6. Deployment (AWS CDK, us-east-2)

`RoofingCrmApi` (Lambda tRPC API behind an HTTP API, DynamoDB leads table, alarms to SNS) and `RoofingCrmWeb` (S3 + CloudFront) are deployed; the URLs are at the top of this document. The steps:

```bash
corepack enable && pnpm install
pnpm --filter @roofing-crm/web build
cd infra
npx cdk bootstrap aws://<account>/us-east-2          # once per account
npx cdk deploy --all \
  -c dataBaseUrl=https://ipfs.io/ipfs/<rootCid> \
  -c llmProvider=bedrock -c llmModelId=<enabled Bedrock inference profile id> \
  -c alarmEmail=oncall@example.com                    # optional; -c pagerDutyEndpoint=<url> also supported
```

Outputs: `RoofingCrmApi.ApiUrl`, `RoofingCrmWeb.WebUrl`. More context keys are listed in `infra/lib/context.ts`:
`dataMode`, `lambdaMemoryMb`, `provisionedConcurrency`, `embeddings`, `roofAgeThresholdYears`,
`longOpenPermitDays`, `corsOrigins`, `apiDomainName` + `apiBasePath`, `retainData`.

**RoofingCrmApi stack:**

- `NodejsFunction` on Node 22, x86_64, 3008 MB by default, 29 s timeout, X-Ray active tracing, JSON logs with
  90-day retention, Powertools environment variables.
- HTTP API (v2) with route `GET|POST /trpc/{proxy+}`, CORS and stage throttling.
- DynamoDB `TableV2`: on-demand, PITR, GSI `byStatus(status, updatedAt)`, retained by default.
- IAM grant `bedrock:InvokeModel*` on Anthropic and Titan-embed foundation models plus the account's
  inference profiles.
- An SNS alarm topic with self-resolving alarms (alarm and OK actions) on Lambda errors, Lambda throttles and
  API 5xx. Email and PagerDuty subscriptions are optional.
- No queue exists, because every call is a synchronous user request, so there is no DLQ.
- Optional custom-domain base-path mapping onto an existing API Gateway domain.

The `project_name=roofing-crm` tag is applied to every resource.

**How DuckDB is packaged for Lambda:** `@duckdb/node-api` loads a native addon (`@duckdb/node-bindings-<platform>`),
so esbuild cannot bundle it. The function marks `@duckdb/*` as external, and an `afterBundling` hook:

1. installs `@duckdb/node-api@<the exact version pinned in apps/api>` into the asset with
   `npm install --os=linux --cpu=x64 --libc=glibc`. The asset therefore contains
   `@duckdb/node-bindings-linux-x64` whatever OS runs the synth;
2. downloads the matching **signed** extensions `httpfs` and `fts` for `v<engine>/linux_amd64` from
   `extensions.duckdb.org` into `/var/task/duckdb_extensions`.

At runtime the Lambda sets `CRM_DUCKDB_EXTENSION_DIR=/var/task/duckdb_extensions`, `CRM_DUCKDB_OFFLINE=true`
(no `INSTALL` from the network) and `HOME=/tmp`. The engine version for the extension URL comes from the pinned
package version, and a test covers that derivation. The unzipped asset is about 112 MB, under Lambda's 250 MB
limit. The bundled artifact itself was executed locally on linux-x64 with offline extensions; see section 8.

**Frontend hosting: S3 + CloudFront, not Amplify.** The kit's Amplify rule requires an Amplify app that is
connected to the Git repository through an OAuth token stored in Secrets Manager. The builds then run inside
Amplify. That setup cannot be expressed in CDK alone: it needs a GitHub token for the `prismteam-ai` org,
created out of band. Amplify's manual-deploy mode also needs a zip upload outside CDK. The web stack instead
uses a private S3 bucket, a CloudFront distribution with Origin Access Control, SPA fallback and security
headers, and a `BucketDeployment`. The deployment writes `config.json` with the API URL at deploy time, so the
same build can be promoted across environments, which is what the Amplify rule's per-branch environment
variables are for.

## 7. Limitations

### Trade-offs

- **Snapshot source:** the hosted CRM reads the snapshot that the pipeline produced on the development machine and published to IPFS; the pipeline's Fargate ingestion stack was not deployed (demo scope, minimal cost).
- **LLM provider:**
  - The hosted API uses Bedrock (`us.anthropic.claude-sonnet-5-5`). Local runs used the Vercel AI SDK Anthropic provider with the same model (`LLM_PROVIDER=anthropic`, `LLM_MODEL_ID=claude-sonnet-5-5`, `LLM_TIMEOUT_MS=120000`). No code differs between providers.
  - If the LLM call fails, the agent answers in retrieval-only mode with the same tools and says so under missing data.
  - Strict tool schemas are not sent to the model: Anthropic's strict mode rejects numeric `minimum`/`maximum`. Tool inputs are still validated against the full Zod schemas before execution.
- **RAG retrieval:**
  - Retrieval is structured (DuckDB radius and filter tools) plus BM25 full-text search over permits.
  - The optional Bedrock Titan embeddings path (`embeddings=bedrock-titan`) is implemented but was not enabled or tested, because Bedrock was not available.
- **Kit alignment:** follows the kit's frontend/backend and engineering guidelines (Turborepo, tRPC on Lambda, CDK, Powertools, Vitest, CI).

### Data and product limitations

- **Roof age:**
  - Where no finaled roof-replacement permit exists, roof age falls back to the Travis Central Appraisal
    District (TCAD) `year_built` (`roof_age_basis = tcad_year_built`, marked "(est.)").
  - Roofs replaced without a permit, and permits filed outside the City of Austin permit dataset, are invisible.
  - In the current snapshot (`run-20261015T060821Z`), roof age comes from a finaled re-roof permit for 10,471
    properties, a finaled new-construction permit for 98,553 and TCAD year built for 223,436; 53,781 have no
    evidence. Year built is the building's age, not the roof's, and pre-1925 years are often appraiser estimates.
    The snapshot's `coverage.json` and the "Data notes" panel show the actual coverage per run.
- **BBB:** `bbb_profiles` is empty until the pipeline's BBB harvest runs from US egress. The UI and the agent
  say "BBB rating not available" and do not invent a score.
- **Ownership tenure:** taken from the TCAD deed date (`last_deed_date`, `ownership_tenure_basis = tcad_deed_date`)
  for 365,846 of 386,241 properties. A deed date is the only ownership-change signal; 13,761 TCAD properties have
  none and 6,634 parcels are not in the TCAD roll. The detail panel and the agent's property tool show it.
- **Permit coverage:** City of Austin permits only. Other Travis jurisdictions such as Pflugerville, Lakeway
  and unincorporated areas are not in the permit source, so a radius near them can show few or no permits.
- **Open duration** is measured from the issue date (or the application date) to the snapshot as-of date, as
  the pipeline computes it.
- **No authentication** on the API or UI (demo scope). Adding Cognito plus a tRPC auth middleware is the next
  step before real use.
- **Lambda cold start over IPFS** depends on gateway latency; `view` mode reads the parquet with range
  requests. Measured on the hosted API: radius queries took 1.8–3.9 s per call over the gateway (under 100 ms
  locally). Use `provisionedConcurrency` or a faster gateway or mirror if this is too slow.
- The candidate list and the map are capped at 2,000 properties per query. Narrow the radius to see all of
  them; the stats always show the full counts.

## 8. Verification log

**Verified:**

- `pnpm install`, `pnpm format:check`, `pnpm typecheck`, `pnpm lint` and `pnpm test` all pass:
  - shared: 12 tests;
  - api: 37 tests (DuckDB queries over a synthetic parquet snapshot, leads in memory/file/DynamoDB-mock,
    agent with the AI SDK mock model, Lambda handler);
  - web: 4 tests;
  - infra: 6 tests, including the bundled API stack with `CDK_BUNDLING_TESTS=1`.
- `pnpm build`, and `pnpm synth` with no AWS credentials and no config or credential files. Both stacks
  synthesize.
- The **bundled Lambda artifact** from `cdk.out` was executed locally. Linux-x64 DuckDB binding, offline
  extensions, `CRM_DUCKDB_OFFLINE=true`: `meta.snapshot` and `agent.ask` returned 200, and `fts` loaded from
  the bundled extension directory.
- UI run in headless Chrome against the synthetic snapshot: county-framed map with an OpenFreeMap basemap,
  radius ring, lead points, candidate list, detail panel (permits, contractor, "BBB rating not available",
  provenance), "+ Lead" into CRM leads, an agent question with assumptions, missing data and citations, and
  the disabled roadmap sections.

**Verified on the real Travis County snapshot** (pipeline run `run-20261015T060821Z`, with TCAD, as of 2026-10-15;
re-run on 2026-10-15):

- **Quality gates:** `pnpm typecheck`, `pnpm lint` and `pnpm test` pass (shared 12, api 37, web 4, infra 5 plus 1
  bundling test skipped by default).
- **`cdk synth`:** succeeds for `RoofingCrmApi` and `RoofingCrmWeb`. The Lambda bundling step calls `pnpm`, so it must be on PATH
  (`corepack enable`); without it, synth fails with `spawnSync pnpm ENOENT`.
- **API smoke test** (`pnpm --filter @roofing-crm/api smoke`, with `CRM_SMOKE_PLACE=Austin`) against the local API
  reading `data/exports/`:
  - **snapshot:** 386,241 `property_leads`, 23,868 `roofing_permits`, 52,413 `contractors`, 0 `bbb_profiles`,
    49 `geo_places`; full-text index loaded.
  - **radius queries** around central Austin, all under 100 ms:

    | Radius | Properties | Roofs ≥ 15 years | With open roofing permits | Long-open permits |
    | ------ | ---------- | ---------------- | ------------------------- | ----------------- |
    | 1 mi   | 2,652      | 1,708            | 14                        | 3                 |
    | 3 mi   | 31,923     | 23,222           | 63                        | 22                |
    | 5 mi   | 71,001     | 52,945           | 107                       | 29                |

    Roofs ≥ 15 years include TCAD year-built estimates (low confidence). On the earlier snapshot without TCAD
    (`run-20261015T051946Z`, permit evidence only) the same radii gave 615 / 6,819 / 14,767.

  - **property detail:** includes provenance (parcel source URL, collected_at, raw SHA-256, run id).
  - **lead records:** create, status update to `contacted`, notes, and filtering by status all work.
  - **live agent** (`anthropic:claude-sonnet-5-5` via the Vercel AI SDK, `LLM_TIMEOUT_MS=120000`), asked "open roofing permits older than
    five years within five miles of Austin":
    - returned 5 permits, longest first: `1989-010586 BP`, 37.6 years open; `2000-000025 BP`, 26.8 years; then 13.0, 11.7 and 5.1 years;
    - gave contractors where listed, 6 citations, its stated assumptions (centre point, definition of "open"), and missing data (BBB not
      available; some permits list no contractor).
- **Web UI** in headless Chrome against the same API:
  - the header shows the snapshot run id and as-of date;
  - the county map shows the pin, radius ring and colour-coded points;
  - the "In this radius" counts match the smoke test (31,923 / 23,222 / 63 / 22 at 3 mi);
  - the property detail panel shows TCAD year built (with "confidence low" and its basis) and the last deed date;
  - the lead table has "+ Lead" buttons;
  - the roadmap sections are locked.
- **Agent strict tool mode:** with the Anthropic provider, strict tool schemas were rejected (`For 'number' type, properties maximum,
minimum are not supported`). Strict mode is therefore off (`strictTools: false`); inputs are still validated against the full Zod
  schemas before a tool runs.

**Not verified:**

- **Titan embeddings:** `embeddings=bedrock-titan` was not enabled.

**Verified on the hosted runtime** (2026-10-15, `pnpm --filter @roofing-crm/api smoke` with
`CRM_SMOKE_API_URL=https://8s9hw4zjlc.execute-api.us-east-2.amazonaws.com`, and the web app in headless Chrome):

- **snapshot:** the deployed Lambda read `run-20261015T060821Z` from IPFS: 386,241 `property_leads`, 23,868 `roofing_permits`,
  52,413 `contractors`, full-text index loaded.
- **radius queries:** identical counts to the local run (1 / 3 / 5 mi: 2,652 / 31,923 / 71,001 properties; 1,708 / 23,222 /
  52,945 roofs ≥ 15 years; 14 / 63 / 107 with open roofing permits), 1.8–3.9 s per call.
- **lead records** in DynamoDB: create, status update, notes and status filter all work; the smoke test deletes its lead afterwards.
- **web app:** loads from CloudFront, shows `Snapshot run-20261015T060821Z · as of 2026-10-15`, the map and the same radius counts.
- **agent** (`bedrock:us.anthropic.claude-sonnet-5-5`): "open roofing permits older than five years within five miles of Austin" returned the same 5 permits as locally, 6 citations, its assumptions and missing data (BBB not available, some permits list no contractor). The first attempt, before Bedrock access was set up for the new account, fell back to retrieval-only mode as designed.

## 9. Open questions

1. _(Applies only if hosting is funded.)_ **Bedrock model:** which inference profile is enabled in the target account? The default
   `us.anthropic.claude-opus-5-5` is configurable through `-c llmModelId` / `LLM_MODEL_ID`.
2. **Snapshot publication:** which IPFS root CID or gateway should production read? A dedicated or pinned
   gateway is recommended for latency.
3. _(Applies only if hosting is funded.)_ **Target AWS account and custom domain:** is there an API Gateway custom domain or base path to map
   (`apiDomainName`/`apiBasePath`), and a CloudFront alias or certificate for the web app?
4. **Long-open threshold:** what counts as "open for an extended period" to the business? Default 365 days,
   set through `CRM_LONG_OPEN_PERMIT_DAYS`.
5. **Auth and tenancy:** which identity provider, and are leads per user, per team or global?
6. _(Applies only if hosting is funded.)_ **Alert routing:** which email or PagerDuty integration endpoint should the alarm topic notify?
