import { DuckDBInstance, listValue, type DuckDBConnection, type DuckDBValue } from "@duckdb/node-api";
import {
  boundingBox,
  bbbProfileSchema,
  contractorSchema,
  permitSummarySchema,
  propertyDetailSchema,
  propertySummarySchema,
  type BbbStatus,
  type Contractor,
  type ContractorDetail,
  type PermitSearchParams,
  type PermitSummary,
  type PropertyDetail,
  type PropertySearchParams,
  type PropertySummary,
  type SnapshotInfo,
} from "@roofing-crm/shared";
import {
  BBB_PROFILES_COLUMNS,
  CONTRACTORS_COLUMNS,
  GEO_PLACES_COLUMNS,
  PROPERTY_LEADS_COLUMNS,
  ROOFING_PERMITS_COLUMNS,
  projection,
  quoteIdent,
  type ColumnSpec,
} from "./columns.js";
import {
  fileUrl,
  readSnapshotJson,
  resolveSnapshotLocation,
  runJsonSchema,
  schemaJsonSchema,
  tablesJsonSchema,
  type SnapshotLocation,
  type SnapshotSchema,
} from "./source.js";

export type SnapshotOptions = {
  baseUrl: string;
  repoRoot: string;
  mode: "materialize" | "view";
  extensionDir?: string;
  memoryLimit?: string;
  threads?: number;
  offline?: boolean;
  /** Logger hook so the data layer stays free of Lambda-specific imports. */
  log?: (message: string, detail?: Record<string, unknown>) => void;
};

export type PropertySearchStats = {
  inRadius: number;
  agedRoofs: number;
  withOpenPermits: number;
  withLongOpenPermits: number;
  matches: number;
};

export type GeoPlace = {
  geoid: string;
  name: string | null;
  basename: string | null;
  place_kind: string | null;
  latitude: number;
  longitude: number;
  match: "exact" | "fuzzy";
  similarity: number;
};

export type TextHit = { kind: "permit"; score: number; permit: PermitSummary };

type Row = Record<string, unknown>;

/** Convert DuckDB JS values (bigint, Date, nested) into JSON-safe primitives. */
function normalizeValue(v: unknown): unknown {
  if (typeof v === "bigint") return Number(v);
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(normalizeValue);
  return v;
}

function normalizeRow(row: Row): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(row)) out[k] = normalizeValue(v);
  return out;
}

const EARTH_RADIUS_MILES = 3958.7613;
/** Haversine distance (miles) between the row's latitude/longitude and ($lat, $lng). */
const DISTANCE_SQL = (alias = "") => {
  const p = alias ? `${alias}.` : "";
  return `(2 * ${EARTH_RADIUS_MILES} * asin(least(1, sqrt(
    pow(sin(radians(${p}latitude - $lat) / 2), 2) +
    cos(radians($lat)) * cos(radians(${p}latitude)) * pow(sin(radians(${p}longitude - $lng) / 2), 2)))))`;
};

const SUMMARY_COLUMNS = Object.keys(propertySummarySchema.shape).filter((c) => c !== "distance_miles");
const PERMIT_COLUMNS = Object.keys(permitSummarySchema.shape).filter((c) => c !== "distance_miles");

export class SnapshotStore {
  private constructor(
    private readonly conn: DuckDBConnection,
    readonly location: SnapshotLocation,
    readonly info: SnapshotInfo,
    readonly ftsEnabled: boolean,
  ) {}

  static async open(opts: SnapshotOptions): Promise<SnapshotStore> {
    const log = opts.log ?? (() => undefined);
    const location = resolveSnapshotLocation(opts.baseUrl, opts.repoRoot);
    const started = Date.now();
    const instance = await DuckDBInstance.create(":memory:");
    const conn = await instance.connect();

    const settings: string[] = [];
    if (opts.extensionDir)
      settings.push(`SET extension_directory = '${opts.extensionDir.replace(/'/g, "''")}'`);
    if (process.env.AWS_LAMBDA_FUNCTION_NAME) settings.push(`SET home_directory = '/tmp'`);
    if (opts.memoryLimit) settings.push(`SET memory_limit = '${opts.memoryLimit.replace(/'/g, "''")}'`);
    if (opts.threads) settings.push(`SET threads = ${Math.floor(opts.threads)}`);
    if (opts.offline) settings.push(`SET autoinstall_known_extensions = false`);
    for (const s of settings) await conn.run(s);

    if (location.kind === "http") await loadExtension(conn, "httpfs", opts.offline);
    let ftsEnabled = true;
    try {
      await loadExtension(conn, "fts", opts.offline);
    } catch (err) {
      ftsEnabled = false;
      log("fts_unavailable", { error: String(err) });
    }

    const [schemaRaw, tablesRaw, runRaw] = await Promise.all([
      readSnapshotJson(location, "schema.json"),
      readSnapshotJson(location, "tables.json"),
      readSnapshotJson(location, "run.json"),
    ]);
    const schema: SnapshotSchema | null = schemaRaw ? schemaJsonSchema.parse(schemaRaw) : null;
    const tables = tablesRaw ? tablesJsonSchema.parse(tablesRaw) : [];
    const run = runRaw ? runJsonSchema.parse(runRaw) : null;

    const limitations: string[] = [];
    const tableFile = (name: string) => tables.find((t) => t.name === name)?.file ?? `tables/${name}.parquet`;

    const columnsOf = async (name: string): Promise<Set<string>> => {
      const fromSchema = schema?.[name]?.columns.map((c) => c.name);
      if (fromSchema) return new Set(fromSchema);
      const reader = await conn.runAndReadAll(
        `DESCRIBE SELECT * FROM read_parquet('${fileUrl(location, tableFile(name)).replace(/'/g, "''")}')`,
      );
      return new Set(reader.getRowObjectsJS().map((r) => String(r.column_name)));
    };

    const createTable = async (
      name: string,
      specs: ColumnSpec[],
      opt: { materialize: boolean; where?: string; dedupeKey?: string; optional?: boolean; source?: string },
    ): Promise<void> => {
      const sourceName = opt.source ?? name;
      const src = `read_parquet('${fileUrl(location, tableFile(sourceName)).replace(/'/g, "''")}')`;
      let available: Set<string>;
      try {
        available = await columnsOf(sourceName);
      } catch (err) {
        if (!opt.optional) throw err;
        limitations.push(`Snapshot table ${name} is unavailable; related features are disabled.`);
        const empty = projection(specs, new Set());
        await conn.run(`CREATE TABLE ${name} AS SELECT ${empty.sql} LIMIT 0`);
        return;
      }
      const proj = projection(specs, available);
      const missingRequired = specs.filter((s) => s.required && proj.missing.includes(s.name));
      if (missingRequired.length) {
        throw new Error(
          `Snapshot table ${sourceName} lacks required columns: ${missingRequired.map((c) => c.name).join(", ")}`,
        );
      }
      if (proj.missing.length)
        limitations.push(`Snapshot ${sourceName} lacks columns: ${proj.missing.join(", ")}.`);
      const qualify = opt.dedupeKey
        ? ` QUALIFY row_number() OVER (PARTITION BY ${quoteIdent(opt.dedupeKey)} ORDER BY ${quoteIdent(opt.dedupeKey)}) = 1`
        : "";
      const body = `SELECT * FROM (SELECT ${proj.sql} FROM ${src}) t${opt.where ? ` WHERE ${opt.where}` : ""}${qualify}`;
      await conn.run(`CREATE ${opt.materialize ? "TABLE" : "VIEW"} ${name} AS ${body}`);
    };

    const materializeLeads = opts.mode === "materialize";
    await createTable("property_leads", PROPERTY_LEADS_COLUMNS, {
      materialize: materializeLeads,
      where: "latitude IS NOT NULL AND longitude IS NOT NULL",
    });
    await createTable("roofing_permits_raw", ROOFING_PERMITS_COLUMNS, {
      materialize: false,
      source: "roofing_permits",
    });
    await createTable("contractors", CONTRACTORS_COLUMNS, { materialize: true, dedupeKey: "contractor_id" });
    await createTable("bbb_profiles", BBB_PROFILES_COLUMNS, {
      materialize: true,
      dedupeKey: "bbb_id",
      optional: true,
    });
    await createTable("geo_places", GEO_PLACES_COLUMNS, {
      materialize: true,
      where: "latitude IS NOT NULL AND longitude IS NOT NULL",
      optional: true,
    });

    // Roofing permits are always materialized (FTS needs a table). Permits without their own
    // coordinates inherit the linked parcel's coordinates so they still participate in radius search.
    await conn.run(`CREATE TABLE roofing_permits AS
      SELECT r.* REPLACE (
          coalesce(r.latitude, pl.latitude) AS latitude,
          coalesce(r.longitude, pl.longitude) AS longitude),
        r.latitude IS NULL AND pl.latitude IS NOT NULL AS coords_from_parcel
      FROM roofing_permits_raw r
      LEFT JOIN (SELECT prop_id, latitude, longitude FROM property_leads) pl USING (prop_id)
      QUALIFY row_number() OVER (PARTITION BY r.permit_number ORDER BY r.permit_number) = 1`);
    await conn.run(`DROP VIEW roofing_permits_raw`);

    if (ftsEnabled) {
      try {
        await conn.run(`PRAGMA create_fts_index('roofing_permits', 'permit_number',
          'description', 'contractor_name', 'contractor_company_name', 'contractor_full_name',
          'address', 'permit_class', 'work_class', 'status', overwrite=1)`);
      } catch (err) {
        ftsEnabled = false;
        log("fts_index_failed", { error: String(err) });
      }
    }
    if (!ftsEnabled)
      limitations.push("Full-text (BM25) search unavailable; agent falls back to substring matching.");

    const count = async (t: string) =>
      Number(
        (await conn.runAndReadAll(`SELECT count(*)::DOUBLE AS n FROM ${t}`)).getRowObjectsJS()[0]?.n ?? 0,
      );
    const tableCounts = [];
    for (const t of ["property_leads", "roofing_permits", "contractors", "bbb_profiles", "geo_places"]) {
      tableCounts.push({ name: t, rows: await count(t) });
    }
    const bbbProfileCount = tableCounts.find((t) => t.name === "bbb_profiles")?.rows ?? 0;
    if (bbbProfileCount === 0) {
      limitations.push(
        "BBB profiles are empty in this snapshot (BBB harvest pending); BBB ratings are not available.",
      );
    }
    for (const s of run?.sources ?? []) {
      if (s.limitation) limitations.push(`${s.source_id ?? "source"}: ${s.limitation}`);
    }

    const asOfRow = (
      await conn.runAndReadAll(
        `SELECT max(as_of_date) AS d FROM (SELECT as_of_date FROM property_leads LIMIT 1000)`,
      )
    ).getRowObjectsJS()[0];
    const info: SnapshotInfo = {
      baseUrl: location.root,
      runId: run?.run?.run_id ?? location.dirRunId,
      asOfDate: run?.asOf ?? (asOfRow?.d ? String(asOfRow.d) : null),
      tables: tableCounts,
      bbbProfileCount,
      limitations,
    };
    log("snapshot_loaded", { ...info, ms: Date.now() - started, ftsEnabled, mode: opts.mode });
    return new SnapshotStore(conn, location, info, ftsEnabled);
  }

  private async all(sql: string, params?: Record<string, DuckDBValue>): Promise<Row[]> {
    // Bind only the parameters the statement references: DuckDB rejects unused named parameters.
    const used = params
      ? Object.fromEntries(Object.entries(params).filter(([k]) => new RegExp(`\\$${k}\\b`).test(sql)))
      : undefined;
    const reader = await this.conn.runAndReadAll(sql, used && Object.keys(used).length ? used : undefined);
    return reader.getRowObjectsJS().map((r) => normalizeRow(r as Row));
  }

  // ------------------------------------------------------------------ properties

  private propertyWhere(p: PropertySearchParams): { cte: string; params: Record<string, DuckDBValue> } {
    const box = boundingBox(p.center, p.radiusMiles);
    const params: Record<string, DuckDBValue> = {
      lat: p.center.lat,
      lng: p.center.lng,
      r: p.radiusMiles,
      minLat: box.minLat,
      maxLat: box.maxLat,
      minLng: box.minLng,
      maxLng: box.maxLng,
      minRoof: p.minRoofAgeYears,
      minOpen: p.minOpenDays,
      longOpen: 0,
    };
    const cte = `base AS (
        SELECT *, ${DISTANCE_SQL()} AS distance_miles FROM property_leads
        WHERE latitude BETWEEN $minLat AND $maxLat AND longitude BETWEEN $minLng AND $maxLng
      ),
      scored AS (
        SELECT *,
          coalesce(roof_age_years >= $minRoof, false) AS aged,
          coalesce(open_roofing_permit_count > 0 AND coalesce(oldest_open_roofing_permit_days, 0) >= $minOpen, false) AS open_permit
        FROM base WHERE distance_miles <= $r
      )`;
    return { cte, params };
  }

  private static modePredicate(mode: PropertySearchParams["matchMode"]): string {
    switch (mode) {
      case "aged_roof":
        return "aged";
      case "open_permit":
        return "open_permit";
      case "both":
        return "aged AND open_permit";
      case "either":
        return "(aged OR open_permit)";
    }
  }

  async searchProperties(
    p: PropertySearchParams,
    longOpenPermitDays: number,
  ): Promise<{ items: PropertySummary[]; total: number; stats: PropertySearchStats }> {
    const { cte, params } = this.propertyWhere(p);
    params.longOpen = longOpenPermitDays;
    const scoreSql = `(least(100, (CASE WHEN open_roofing_permit_count > 0 THEN coalesce(oldest_open_roofing_permit_days, 0) ELSE 0 END) / 365.0 * 10)
      + CASE WHEN aged THEN least(50, greatest(0, roof_age_years - $minRoof) + 1) ELSE 0 END
      + CASE WHEN aged AND open_roofing_permit_count > 0 THEN 25 ELSE 0 END)`;
    const order: Record<PropertySearchParams["sort"], string> = {
      priority: `${scoreSql} DESC, distance_miles ASC`,
      open_days_desc: "oldest_open_roofing_permit_days DESC NULLS LAST, distance_miles ASC",
      roof_age_desc: "roof_age_years DESC NULLS LAST, distance_miles ASC",
      distance_asc: "distance_miles ASC",
    };
    const where = SnapshotStore.modePredicate(p.matchMode);
    const rows = await this.all(
      `WITH ${cte}
       SELECT ${SUMMARY_COLUMNS.map(quoteIdent).join(", ")}, distance_miles, count(*) OVER () AS total_matches
       FROM scored WHERE ${where}
       ORDER BY ${order[p.sort]}, prop_id
       LIMIT ${Math.floor(p.limit)}`,
      params,
    );
    const statsRows = await this.all(
      `WITH ${cte}
       SELECT count(*)::DOUBLE AS in_radius,
         count(*) FILTER (WHERE aged)::DOUBLE AS aged,
         count(*) FILTER (WHERE open_permit)::DOUBLE AS open_permit,
         count(*) FILTER (WHERE open_permit AND oldest_open_roofing_permit_days >= $longOpen)::DOUBLE AS long_open,
         count(*) FILTER (WHERE ${where})::DOUBLE AS matches
       FROM scored`,
      params,
    );
    const s = statsRows[0] ?? {};
    const total = rows.length ? Number(rows[0]?.total_matches ?? 0) : 0;
    return {
      items: rows.map((r) => propertySummarySchema.parse(r)),
      total,
      stats: {
        inRadius: Number(s.in_radius ?? 0),
        agedRoofs: Number(s.aged ?? 0),
        withOpenPermits: Number(s.open_permit ?? 0),
        withLongOpenPermits: Number(s.long_open ?? 0),
        matches: Number(s.matches ?? 0),
      },
    };
  }

  async getProperty(propId: string): Promise<PropertyDetail | null> {
    const cols = Object.keys(propertyDetailSchema.shape).filter((c) => c !== "distance_miles");
    const rows = await this.all(
      `SELECT ${cols.map(quoteIdent).join(", ")}, NULL::DOUBLE AS distance_miles FROM property_leads WHERE prop_id = $id LIMIT 1`,
      { id: propId },
    );
    return rows[0] ? propertyDetailSchema.parse(rows[0]) : null;
  }

  // ------------------------------------------------------------------ permits

  async searchPermits(p: PermitSearchParams): Promise<{ items: PermitSummary[]; total: number }> {
    const box = boundingBox(p.center, p.radiusMiles);
    const params: Record<string, DuckDBValue> = {
      lat: p.center.lat,
      lng: p.center.lng,
      r: p.radiusMiles,
      minLat: box.minLat,
      maxLat: box.maxLat,
      minLng: box.minLng,
      maxLng: box.maxLng,
      minOpen: p.minOpenDays,
      statuses: listValue(p.statuses),
    };
    const filters = ["distance_miles <= $r"];
    if (p.openOnly) filters.push("coalesce(is_open, false)");
    if (p.minOpenDays > 0) filters.push("coalesce(open_days, 0) >= $minOpen");
    if (p.statuses.length) filters.push("list_contains($statuses, status)");
    const order: Record<PermitSearchParams["sort"], string> = {
      open_days_desc: "open_days DESC NULLS LAST, distance_miles ASC",
      issued_desc: "coalesce(issued_date, applied_date) DESC NULLS LAST",
      distance_asc: "distance_miles ASC",
    };
    const rows = await this.all(
      `WITH base AS (
         SELECT *, ${DISTANCE_SQL()} AS distance_miles FROM roofing_permits
         WHERE latitude BETWEEN $minLat AND $maxLat AND longitude BETWEEN $minLng AND $maxLng
       )
       SELECT ${PERMIT_COLUMNS.map(quoteIdent).join(", ")}, distance_miles, count(*) OVER () AS total_matches
       FROM base WHERE ${filters.join(" AND ")}
       ORDER BY ${order[p.sort]}, permit_number
       LIMIT ${Math.floor(p.limit)}`,
      params,
    );
    const total = rows.length ? Number(rows[0]?.total_matches ?? 0) : 0;
    return { items: rows.map((r) => permitSummarySchema.parse(r)), total };
  }

  async permitStatuses(): Promise<{ status: string; count: number; open: number }[]> {
    const rows = await this.all(
      `SELECT status, count(*)::DOUBLE AS n, count(*) FILTER (WHERE is_open)::DOUBLE AS open
       FROM roofing_permits WHERE status IS NOT NULL GROUP BY status ORDER BY n DESC`,
    );
    return rows.map((r) => ({ status: String(r.status), count: Number(r.n), open: Number(r.open) }));
  }

  async getPermit(permitNumber: string): Promise<PermitSummary | null> {
    const rows = await this.all(
      `SELECT ${PERMIT_COLUMNS.map(quoteIdent).join(", ")}, NULL::DOUBLE AS distance_miles
       FROM roofing_permits WHERE permit_number = $id LIMIT 1`,
      { id: permitNumber },
    );
    return rows[0] ? permitSummarySchema.parse(rows[0]) : null;
  }

  async permitsForProperty(propId: string): Promise<PermitSummary[]> {
    const rows = await this.all(
      `SELECT ${PERMIT_COLUMNS.map(quoteIdent).join(", ")}, NULL::DOUBLE AS distance_miles
       FROM roofing_permits WHERE prop_id = $id
       ORDER BY coalesce(is_open, false) DESC, coalesce(issued_date, applied_date) DESC NULLS LAST`,
      { id: propId },
    );
    return rows.map((r) => permitSummarySchema.parse(r));
  }

  // ------------------------------------------------------------------ contractors / BBB

  async getContractor(contractorId: string): Promise<Contractor | null> {
    const rows = await this.all(
      `SELECT ${CONTRACTORS_COLUMNS.map((c) => quoteIdent(c.name)).join(", ")} FROM contractors WHERE contractor_id = $id`,
      { id: contractorId },
    );
    const r = rows[0];
    if (!r) return null;
    return contractorSchema.parse({
      ...r,
      name_variants: r.name_variants ?? [],
      phones: r.phones ?? [],
      trades: r.trades ?? [],
    });
  }

  async bbbStatus(bbbId: string | null): Promise<BbbStatus> {
    if (this.info.bbbProfileCount === 0) {
      return {
        state: "unavailable",
        reason: "BBB rating not available: BBB profiles have not been harvested into this snapshot yet.",
      };
    }
    if (!bbbId)
      return { state: "not_linked", reason: "No unambiguous BBB profile match for this contractor." };
    const rows = await this.all(
      `SELECT ${BBB_PROFILES_COLUMNS.map((c) => quoteIdent(c.name)).join(", ")} FROM bbb_profiles WHERE bbb_id = $id`,
      { id: bbbId },
    );
    return rows[0]
      ? { state: "available", profile: bbbProfileSchema.parse(rows[0]) }
      : { state: "not_linked", reason: `Linked BBB profile ${bbbId} is not present in this snapshot.` };
  }

  async contractorDetail(contractorId: string | null): Promise<ContractorDetail> {
    const contractor = contractorId ? await this.getContractor(contractorId) : null;
    return { contractor, bbb: await this.bbbStatus(contractor?.bbb_id ?? null) };
  }

  async contractorPermits(contractorId: string, limit = 25): Promise<PermitSummary[]> {
    const rows = await this.all(
      `SELECT ${PERMIT_COLUMNS.map(quoteIdent).join(", ")}, NULL::DOUBLE AS distance_miles
       FROM roofing_permits WHERE contractor_id = $id
       ORDER BY coalesce(issued_date, applied_date) DESC NULLS LAST LIMIT ${Math.floor(limit)}`,
      { id: contractorId },
    );
    return rows.map((r) => permitSummarySchema.parse(r));
  }

  // ------------------------------------------------------------------ geocoding / text retrieval

  /** Resolve a place name ("Pflugerville", "Lakeway, TX") to Census place centroids. */
  async geocodePlace(query: string, limit = 5): Promise<GeoPlace[]> {
    const q = query
      .toLowerCase()
      .replace(/,?\s*(tx|texas)\.?$/i, "")
      .replace(/^(the\s+)?city\s+of\s+/i, "")
      .trim();
    if (!q) return [];
    const rows = await this.all(
      `WITH c AS (
         SELECT *,
           lower(coalesce(basename, '')) = $q OR lower(coalesce(name, '')) = $q AS exact,
           greatest(jaro_winkler_similarity(lower(coalesce(basename, '')), $q),
                    jaro_winkler_similarity(lower(coalesce(name, '')), $q)) AS sim
         FROM geo_places
       )
       SELECT geoid, name, basename, place_kind, latitude, longitude, exact, sim FROM c
       WHERE exact OR sim >= 0.88
       ORDER BY exact DESC, sim DESC, CASE WHEN place_kind ILIKE '%city%' THEN 0 ELSE 1 END
       LIMIT ${Math.floor(limit)}`,
      { q },
    );
    return rows.map((r) => ({
      geoid: String(r.geoid),
      name: (r.name as string | null) ?? null,
      basename: (r.basename as string | null) ?? null,
      place_kind: (r.place_kind as string | null) ?? null,
      latitude: Number(r.latitude),
      longitude: Number(r.longitude),
      match: r.exact ? "exact" : "fuzzy",
      similarity: Math.round(Number(r.sim) * 1000) / 1000,
    }));
  }

  async listPlaceNames(limit = 200): Promise<string[]> {
    const rows = await this.all(
      `SELECT DISTINCT basename FROM geo_places WHERE basename IS NOT NULL ORDER BY 1 LIMIT ${limit}`,
    );
    return rows.map((r) => String(r.basename));
  }

  /**
   * BM25 retrieval over roofing permit text (description, contractor names, address, class, status),
   * optionally constrained to a radius and open permits. Falls back to ILIKE when FTS is unavailable.
   */
  async searchPermitText(
    query: string,
    opts: { center?: { lat: number; lng: number }; radiusMiles?: number; openOnly?: boolean; limit?: number },
  ): Promise<TextHit[]> {
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 200);
    const params: Record<string, DuckDBValue> = { q: query };
    const filters: string[] = [];
    let distance = "NULL::DOUBLE";
    if (opts.center && opts.radiusMiles) {
      const box = boundingBox(opts.center, opts.radiusMiles);
      Object.assign(params, {
        lat: opts.center.lat,
        lng: opts.center.lng,
        r: opts.radiusMiles,
        minLat: box.minLat,
        maxLat: box.maxLat,
        minLng: box.minLng,
        maxLng: box.maxLng,
      });
      distance = DISTANCE_SQL();
      filters.push(
        "latitude BETWEEN $minLat AND $maxLat AND longitude BETWEEN $minLng AND $maxLng",
        `${DISTANCE_SQL()} <= $r`,
      );
    }
    if (opts.openOnly) filters.push("coalesce(is_open, false)");
    const scoreSql = this.ftsEnabled
      ? "fts_main_roofing_permits.match_bm25(permit_number, $q)"
      : `CASE WHEN concat_ws(' ', description, contractor_name, contractor_company_name, address) ILIKE '%' || $q || '%' THEN 1.0 END`;
    const rows = await this.all(
      `SELECT * FROM (
         SELECT ${PERMIT_COLUMNS.map(quoteIdent).join(", ")}, ${distance} AS distance_miles, ${scoreSql} AS score
         FROM roofing_permits ${filters.length ? `WHERE ${filters.join(" AND ")}` : ""}
       ) WHERE score IS NOT NULL ORDER BY score DESC, open_days DESC NULLS LAST LIMIT ${limit}`,
      params,
    );
    return rows.map((r) => ({
      kind: "permit" as const,
      score: Math.round(Number(r.score) * 1000) / 1000,
      permit: permitSummarySchema.parse(r),
    }));
  }
}

async function loadExtension(
  conn: DuckDBConnection,
  name: "fts" | "httpfs",
  offline?: boolean,
): Promise<void> {
  try {
    await conn.run(`LOAD ${name}`);
  } catch (err) {
    if (offline) throw err;
    await conn.run(`INSTALL ${name}`);
    await conn.run(`LOAD ${name}`);
  }
}
