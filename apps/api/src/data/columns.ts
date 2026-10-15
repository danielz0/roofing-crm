/**
 * Columns the CRM reads from each snapshot table, with the type the API normalizes them to.
 * The snapshot's `schema.json` is authoritative: a column listed here but absent from the snapshot
 * is projected as NULL and reported as a limitation, so a pipeline schema change degrades gracefully.
 */
export type ColumnKind = "string" | "number" | "bool" | "string_list";
export type ColumnSpec = { name: string; kind: ColumnKind; required?: boolean };

const str = (name: string, required = false): ColumnSpec => ({ name, kind: "string", required });
const num = (name: string, required = false): ColumnSpec => ({ name, kind: "number", required });
const bool = (name: string): ColumnSpec => ({ name, kind: "bool" });
const list = (name: string): ColumnSpec => ({ name, kind: "string_list" });

export const PROPERTY_LEADS_COLUMNS: ColumnSpec[] = [
  str("prop_id", true),
  str("geo_id"),
  str("situs_address"),
  str("situs_number"),
  str("situs_street"),
  str("situs_city"),
  str("situs_zip"),
  num("latitude", true),
  num("longitude", true),
  str("owner_name"),
  str("owner_care_of"),
  str("mail_address"),
  str("mail_city"),
  str("mail_state"),
  str("mail_zip"),
  str("owner_location_class"),
  bool("absentee_owner_signal"),
  str("land_use_state_code"),
  str("land_use_local_code"),
  num("land_value"),
  num("improvement_value"),
  num("market_value"),
  num("gis_area"),
  str("gis_area_unit"),
  num("tax_year"),
  num("year_built"),
  num("roof_year"),
  num("roof_age_years"),
  str("roof_age_basis"),
  str("roof_age_confidence"),
  str("roof_evidence_date"),
  str("roof_evidence_permit_number"),
  num("roof_evidence_count"),
  num("roofing_permit_count"),
  num("open_roofing_permit_count"),
  num("oldest_open_roofing_permit_days"),
  str("oldest_open_roofing_permit_number"),
  num("expired_unfinaled_roofing_permit_count"),
  str("last_roofing_permit_number"),
  str("last_roofing_permit_date"),
  num("permit_count"),
  str("last_deed_date"),
  str("ownership_tenure_basis"),
  str("parcel_source_id"),
  str("parcel_source_url"),
  str("parcel_raw_sha256"),
  str("parcel_collected_at"),
  str("first_seen_run"),
  str("last_changed_run"),
  str("as_of_date"),
];

export const ROOFING_PERMITS_COLUMNS: ColumnSpec[] = [
  str("permit_number", true),
  str("prop_id"),
  str("parcel_match_method"),
  bool("in_county"),
  str("permit_type"),
  str("permit_class"),
  str("work_class"),
  str("description"),
  str("roofing_match"),
  str("status"),
  bool("is_open"),
  str("applied_date"),
  str("issued_date"),
  str("status_date"),
  str("expires_date"),
  str("completed_date"),
  num("open_days"),
  bool("expired_without_final"),
  str("address"),
  str("city"),
  str("zip"),
  str("jurisdiction"),
  num("latitude"),
  num("longitude"),
  str("contractor_company_name"),
  str("contractor_full_name"),
  str("contractor_phone"),
  str("contractor_trade"),
  str("contractor_id"),
  str("contractor_name"),
  str("contractor_taxpayer_number"),
  str("contractor_bbb_id"),
  str("contractor_bbb_rating"),
  bool("contractor_bbb_accredited"),
  num("total_job_valuation"),
  str("permit_link"),
  str("source_id"),
  str("source_url"),
  str("raw_sha256"),
  str("collected_at"),
  str("first_seen_run"),
  str("last_changed_run"),
];

export const CONTRACTORS_COLUMNS: ColumnSpec[] = [
  str("contractor_id", true),
  str("display_name"),
  list("name_variants"),
  list("phones"),
  str("address"),
  str("city"),
  str("zip"),
  list("trades"),
  num("permit_count"),
  num("roofing_permit_count"),
  num("open_roofing_permit_count"),
  str("first_permit_issued"),
  str("last_permit_issued"),
  str("taxpayer_number"),
  str("business_match_method"),
  str("place_id"),
  str("bbb_id"),
];

export const BBB_PROFILES_COLUMNS: ColumnSpec[] = [
  str("bbb_id", true),
  str("name"),
  str("rating"),
  bool("accredited"),
  str("profile_url"),
];

export const GEO_PLACES_COLUMNS: ColumnSpec[] = [
  str("geoid", true),
  str("name"),
  str("basename"),
  str("place_kind"),
  num("latitude", true),
  num("longitude", true),
];

const SQL_TYPE: Record<ColumnKind, string> = {
  string: "VARCHAR",
  number: "DOUBLE",
  bool: "BOOLEAN",
  string_list: "VARCHAR[]",
};

export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Build a normalized projection given the columns actually present in the snapshot. */
export function projection(
  specs: ColumnSpec[],
  available: Set<string>,
  alias = "",
): { sql: string; missing: string[] } {
  const prefix = alias ? `${alias}.` : "";
  const missing: string[] = [];
  const parts = specs.map((c) => {
    const target = SQL_TYPE[c.kind];
    if (!available.has(c.name)) {
      missing.push(c.name);
      return `NULL::${target} AS ${quoteIdent(c.name)}`;
    }
    const src = `${prefix}${quoteIdent(c.name)}`;
    const expr = c.kind === "string" ? `CAST(${src} AS VARCHAR)` : `TRY_CAST(${src} AS ${target})`;
    return `${expr} AS ${quoteIdent(c.name)}`;
  });
  return { sql: parts.join(",\n  "), missing };
}
