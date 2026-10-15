import { beforeAll, describe, expect, it } from "vitest";
import { permitSearchInputSchema, propertySearchInputSchema } from "@roofing-crm/shared";
import { SnapshotStore } from "../src/data/snapshot.js";
import { resolveSnapshotLocation } from "../src/data/source.js";
import { createSyntheticSnapshot, FIXTURE } from "./fixtures/synthetic-snapshot.js";
import path from "node:path";

let store: SnapshotStore;
let dir: string;

beforeAll(async () => {
  dir = await createSyntheticSnapshot();
  store = await SnapshotStore.open({ baseUrl: dir, repoRoot: "/", mode: "materialize" });
});

const props = (input: Parameters<typeof propertySearchInputSchema.parse>[0]) =>
  store.searchProperties(propertySearchInputSchema.parse(input), 365);
const permits = (input: Parameters<typeof permitSearchInputSchema.parse>[0]) =>
  store.searchPermits(permitSearchInputSchema.parse(input));

describe("snapshot location", () => {
  it("picks the latest run when pointed at an exports directory", () => {
    const loc = resolveSnapshotLocation(path.dirname(dir), "/");
    expect(loc.dirRunId).toBe(FIXTURE.runId);
  });

  it("treats https URLs as remote", () => {
    expect(resolveSnapshotLocation("https://ipfs.io/ipfs/bafyroot/", "/")).toMatchObject({
      kind: "http",
      root: "https://ipfs.io/ipfs/bafyroot",
    });
  });
});

describe("snapshot info", () => {
  it("reads run id, row counts and BBB limitation", () => {
    expect(store.info.runId).toBe(FIXTURE.runId);
    expect(store.info.tables.find((t) => t.name === "property_leads")?.rows).toBe(5); // P5 has no coordinates
    expect(store.info.bbbProfileCount).toBe(0);
    expect(store.info.limitations.join(" ")).toMatch(/BBB/);
    expect(store.ftsEnabled).toBe(true);
  });
});

describe("property radius search", () => {
  it("returns aged roofs and open permits inside the radius, highest priority first", async () => {
    const res = await props({ center: FIXTURE.center, radiusMiles: 3 });
    expect(res.items.map((p) => p.prop_id)).toEqual(["P1", "P3"]);
    expect(res.stats).toEqual({
      inRadius: 3,
      agedRoofs: 2,
      withOpenPermits: 1,
      withLongOpenPermits: 1,
      matches: 2,
    });
    expect(res.items[0]?.distance_miles).toBeCloseTo(0, 5);
  });

  it("radius controls inclusion", async () => {
    const res = await props({ center: FIXTURE.center, radiusMiles: 10, matchMode: "open_permit" });
    expect(res.items.map((p) => p.prop_id).sort()).toEqual(["P1", "P4"]);
  });

  it("roof-age threshold is configurable", async () => {
    const res = await props({
      center: FIXTURE.center,
      radiusMiles: 3,
      matchMode: "aged_roof",
      minRoofAgeYears: 20,
    });
    expect(res.items.map((p) => p.prop_id)).toEqual(["P1"]);
  });

  it("filters open permits by minimum open duration", async () => {
    const res = await props({
      center: FIXTURE.center,
      radiusMiles: 10,
      matchMode: "open_permit",
      minOpenDays: 1000,
    });
    expect(res.items.map((p) => p.prop_id)).toEqual(["P1"]);
  });

  it("sorts by open duration", async () => {
    const res = await props({ center: FIXTURE.center, radiusMiles: 10, sort: "open_days_desc" });
    expect(res.items[0]?.prop_id).toBe("P1");
  });
});

describe("permit radius search", () => {
  it("open only by default, longest open first", async () => {
    const res = await permits({ center: FIXTURE.center, radiusMiles: 10 });
    expect(res.items.map((p) => p.permit_number)).toEqual(["A-OPEN", "B-OPEN"]);
  });

  it("permits without coordinates inherit parcel coordinates", async () => {
    const res = await permits({ center: FIXTURE.center, radiusMiles: 3, openOnly: false });
    expect(res.items.map((p) => p.permit_number).sort()).toEqual(["A-OPEN", "C-FINAL", "E-EXPIRED"]);
  });

  it("filters by status", async () => {
    const res = await permits({
      center: FIXTURE.center,
      radiusMiles: 3,
      openOnly: false,
      statuses: ["Expired"],
    });
    expect(res.items.map((p) => p.permit_number)).toEqual(["E-EXPIRED"]);
    expect(res.items[0]?.expired_without_final).toBe(true);
  });

  it("lists statuses", async () => {
    const statuses = await store.permitStatuses();
    expect(statuses.find((s) => s.status === "Active")).toEqual({ status: "Active", count: 3, open: 3 });
  });
});

describe("details, contractors, BBB", () => {
  it("property detail includes provenance fields", async () => {
    const p = await store.getProperty("P3");
    expect(p?.owner_care_of).toBe("C/O TRUST");
    expect(p?.roof_evidence_permit_number).toBe("C-FINAL");
    expect(p?.parcel_source_url).toBe("https://example.test/parcel/P3");
    expect(p?.distance_miles).toBeNull();
  });

  it("contractor with BBB unavailable is reported gracefully", async () => {
    const d = await store.contractorDetail("ctr_acme");
    expect(d.contractor?.display_name).toBe("Acme Roofing LLC");
    expect(d.contractor?.name_variants).toContain("ACME ROOFING");
    expect(d.bbb.state).toBe("unavailable");
  });
});

describe("geocoding and text retrieval", () => {
  it("geocodes exact and fuzzy place names", async () => {
    expect((await store.geocodePlace("Testville, TX"))[0]).toMatchObject({
      basename: "Testville",
      match: "exact",
    });
    expect((await store.geocodePlace("Testvile"))[0]).toMatchObject({
      basename: "Testville",
      match: "fuzzy",
    });
    expect(await store.geocodePlace("Nowhereburg")).toEqual([]);
  });

  it("BM25 finds permits by description and contractor", async () => {
    const tear = await store.searchPermitText("tear off", {});
    expect(tear[0]?.permit.permit_number).toBe("B-OPEN");
    const acme = await store.searchPermitText("acme", { openOnly: true });
    expect(acme.map((h) => h.permit.permit_number).sort()).toEqual(["A-OPEN", "D-OPEN"]);
  });

  it("text search respects radius", async () => {
    const hits = await store.searchPermitText("acme", { center: FIXTURE.testville, radiusMiles: 2 });
    expect(hits.map((h) => h.permit.permit_number)).toEqual(["D-OPEN"]);
  });
});

describe("view mode", () => {
  it("returns the same results when parquet is queried in place", async () => {
    const viewStore = await SnapshotStore.open({ baseUrl: dir, repoRoot: "/", mode: "view" });
    const res = await viewStore.searchProperties(
      propertySearchInputSchema.parse({ center: FIXTURE.center, radiusMiles: 3 }),
      365,
    );
    expect(res.items.map((p) => p.prop_id)).toEqual(["P1", "P3"]);
  });
});
