/**
 * End-to-end smoke test against a running API (local dev server or deployed API Gateway URL),
 * using the shared typed client. Usage:
 *   pnpm --filter @roofing-crm/api smoke            # http://localhost:4000
 *   CRM_SMOKE_API_URL=https://... pnpm --filter @roofing-crm/api smoke
 * Creates a lead, updates it, adds a note and deletes it again (leaves no residue).
 */
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import type { AppRouter } from "../src/routers/index.js";

const apiUrl = process.env.CRM_SMOKE_API_URL ?? `http://localhost:${process.env.CRM_API_PORT ?? 4000}`;
// The api package cannot depend on @roofing-crm/api-client (that would be a workspace cycle), so the
// smoke script builds the same typed client inline.
const api = createTRPCClient<AppRouter>({
  links: [httpBatchLink({ url: `${apiUrl.replace(/\/+$/, "")}/trpc` })],
});

const config = await api.meta.config.query();
const snapshot = await api.meta.snapshot.query();
console.log("snapshot", {
  runId: snapshot.runId,
  asOf: snapshot.asOfDate,
  tables: snapshot.tables,
  fts: snapshot.ftsEnabled,
});
console.log("limitations", snapshot.limitations);

const center = config.county.center;
for (const radiusMiles of [1, 3, 5]) {
  const started = Date.now();
  const res = await api.properties.search.query({ center, radiusMiles, limit: 500 });
  console.log(`properties r=${radiusMiles}mi`, {
    ...res.stats,
    returned: res.items.length,
    ms: Date.now() - started,
  });
}
const aged = await api.properties.search.query({
  center,
  radiusMiles: 3,
  matchMode: "aged_roof",
  sort: "roof_age_desc",
  limit: 5,
});
console.log(
  "oldest roofs r=3mi",
  aged.items.map((p) => [p.prop_id, p.situs_address, p.roof_age_years, p.roof_age_basis]),
);

const open = await api.permits.search.query({
  center,
  radiusMiles: 5,
  openOnly: true,
  sort: "open_days_desc",
  limit: 5,
});
console.log("open roofing permits r=5mi", { total: open.total });
console.log(open.items.map((p) => [p.permit_number, p.status, p.open_days, p.contractor_name, p.prop_id]));

const fiveYears = await api.permits.search.query({
  center,
  radiusMiles: 5,
  openOnly: true,
  minOpenDays: 1825,
  limit: 1,
});
console.log("open > 5y r=5mi", { total: fiveYears.total });
console.log("statuses", await api.permits.statuses.query());

const target = aged.items[0] ?? open.items.find((p) => p.prop_id);
const propId = target && "prop_id" in target ? target.prop_id : null;
if (propId) {
  const detail = await api.properties.get.query({ propId });
  console.log("detail", {
    propId,
    permits: detail.permits.length,
    contractors: detail.contractors.map((c) => [c.contractor?.display_name, c.bbb.state]),
    provenance: detail.provenance,
  });
  const created = await api.leads.create.mutate({ propId, source: "map", note: "smoke test" });
  const updated = await api.leads.updateStatus.mutate({ id: created.lead.id, status: "contacted" });
  const noted = await api.leads.addNote.mutate({ id: created.lead.id, text: "second note" });
  const listed = await api.leads.list.query({ status: "contacted" });
  console.log("lead crud", {
    created: created.created,
    id: created.lead.id,
    status: updated.status,
    notes: noted.notes.length,
    inContactedList: listed.some((l) => l.id === created.lead.id),
  });
  if (created.created) await api.leads.delete.mutate({ id: created.lead.id });
}

const placeName = process.env.CRM_SMOKE_PLACE ?? "Pflugerville";
const answer = await api.agent.ask.mutate({
  question: `show me open roofing permits older than five years within five miles of ${placeName}`,
});
console.log("agent", {
  model: answer.model,
  permits: answer.permits.length,
  citations: answer.citations.length,
});
console.log(answer.answer.split("\n").slice(0, 8).join("\n"));
console.log("assumptions", answer.assumptions);
console.log("missing", answer.missingData);
