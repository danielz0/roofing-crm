import { z } from "zod";
import {
  DEFAULT_RADIUS_MILES,
  DEFAULT_ROOF_AGE_THRESHOLD_YEARS,
  LEAD_STATUSES,
  MAX_RADIUS_MILES,
  MAX_RESULTS,
} from "./constants.js";

export const geoPointSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

export const radiusSchema = z.number().positive().max(MAX_RADIUS_MILES);

/** How the aged-roof and open-permit criteria combine for a property to count as a lead. */
export const leadMatchModeSchema = z.enum(["either", "aged_roof", "open_permit", "both"]);
export type LeadMatchMode = z.infer<typeof leadMatchModeSchema>;

export const propertySortSchema = z.enum(["priority", "open_days_desc", "roof_age_desc", "distance_asc"]);

export const propertySearchInputSchema = z.object({
  center: geoPointSchema,
  radiusMiles: radiusSchema.default(DEFAULT_RADIUS_MILES),
  matchMode: leadMatchModeSchema.default("either"),
  minRoofAgeYears: z.number().int().min(0).max(200).default(DEFAULT_ROOF_AGE_THRESHOLD_YEARS),
  /** Only count open roofing permits that have been open at least this many days. */
  minOpenDays: z.number().int().min(0).default(0),
  sort: propertySortSchema.default("priority"),
  limit: z.number().int().min(1).max(MAX_RESULTS).default(500),
});
export type PropertySearchInput = z.input<typeof propertySearchInputSchema>;
export type PropertySearchParams = z.output<typeof propertySearchInputSchema>;

export const permitSortSchema = z.enum(["open_days_desc", "issued_desc", "distance_asc"]);

export const permitSearchInputSchema = z.object({
  center: geoPointSchema,
  radiusMiles: radiusSchema.default(DEFAULT_RADIUS_MILES),
  openOnly: z.boolean().default(true),
  minOpenDays: z.number().int().min(0).default(0),
  /** Exact permit status values from the source (e.g. "Active", "Expired", "Final"). Empty = any. */
  statuses: z.array(z.string().min(1)).default([]),
  sort: permitSortSchema.default("open_days_desc"),
  limit: z.number().int().min(1).max(MAX_RESULTS).default(500),
});
export type PermitSearchInput = z.input<typeof permitSearchInputSchema>;
export type PermitSearchParams = z.output<typeof permitSearchInputSchema>;

const n = z.number().nullable();
const s = z.string().nullable();
const b = z.boolean().nullable();

/** Map/list row for a property. Field names follow the snapshot's `property_leads` columns. */
export const propertySummarySchema = z.object({
  prop_id: z.string(),
  situs_address: s,
  situs_city: s,
  situs_zip: s,
  latitude: z.number(),
  longitude: z.number(),
  /** Miles from the search center; null when the row was fetched by id. */
  distance_miles: n,
  owner_name: s,
  market_value: n,
  land_use_state_code: s,
  year_built: n,
  roof_year: n,
  roof_age_years: n,
  roof_age_basis: s,
  roof_age_confidence: s,
  roofing_permit_count: z.number(),
  open_roofing_permit_count: z.number(),
  oldest_open_roofing_permit_days: n,
  oldest_open_roofing_permit_number: s,
  expired_unfinaled_roofing_permit_count: z.number(),
  parcel_source_url: s,
});
export type PropertySummary = z.infer<typeof propertySummarySchema>;

export const permitSummarySchema = z.object({
  permit_number: z.string(),
  prop_id: s,
  parcel_match_method: s,
  permit_type: s,
  permit_class: s,
  work_class: s,
  description: s,
  status: s,
  is_open: b,
  applied_date: s,
  issued_date: s,
  status_date: s,
  expires_date: s,
  completed_date: s,
  open_days: n,
  expired_without_final: b,
  address: s,
  city: s,
  zip: s,
  latitude: n,
  longitude: n,
  distance_miles: n,
  contractor_id: s,
  contractor_name: s,
  contractor_company_name: s,
  contractor_full_name: s,
  contractor_phone: s,
  contractor_bbb_id: s,
  contractor_bbb_rating: s,
  contractor_bbb_accredited: b,
  total_job_valuation: n,
  permit_link: s,
  source_id: s,
  source_url: s,
  collected_at: s,
  raw_sha256: s,
  first_seen_run: s,
  last_changed_run: s,
});
export type PermitSummary = z.infer<typeof permitSummarySchema>;

export const propertyDetailSchema = propertySummarySchema.extend({
  geo_id: s,
  situs_number: s,
  situs_street: s,
  owner_care_of: s,
  mail_address: s,
  mail_city: s,
  mail_state: s,
  mail_zip: s,
  owner_location_class: s,
  absentee_owner_signal: b,
  land_use_local_code: s,
  land_value: n,
  improvement_value: n,
  gis_area: n,
  gis_area_unit: s,
  tax_year: n,
  roof_evidence_date: s,
  roof_evidence_permit_number: s,
  roof_evidence_count: n,
  last_roofing_permit_number: s,
  last_roofing_permit_date: s,
  permit_count: n,
  last_deed_date: s,
  ownership_tenure_basis: s,
  parcel_source_id: s,
  parcel_raw_sha256: s,
  parcel_collected_at: s,
  first_seen_run: s,
  last_changed_run: s,
  as_of_date: s,
});
export type PropertyDetail = z.infer<typeof propertyDetailSchema>;

export const contractorSchema = z.object({
  contractor_id: z.string(),
  display_name: s,
  name_variants: z.array(z.string()),
  phones: z.array(z.string()),
  address: s,
  city: s,
  zip: s,
  trades: z.array(z.string()),
  permit_count: n,
  roofing_permit_count: n,
  open_roofing_permit_count: n,
  first_permit_issued: s,
  last_permit_issued: s,
  taxpayer_number: s,
  business_match_method: s,
  place_id: s,
  bbb_id: s,
});
export type Contractor = z.infer<typeof contractorSchema>;

export const bbbProfileSchema = z.object({
  bbb_id: z.string(),
  name: s,
  rating: s,
  accredited: b,
  profile_url: s,
});
export type BbbProfile = z.infer<typeof bbbProfileSchema>;

/** BBB lookup outcome. `unavailable` is a first-class state: the snapshot may carry no BBB data. */
export const bbbStatusSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("available"), profile: bbbProfileSchema }),
  z.object({ state: z.literal("not_linked"), reason: z.string() }),
  z.object({ state: z.literal("unavailable"), reason: z.string() }),
]);
export type BbbStatus = z.infer<typeof bbbStatusSchema>;

export const contractorDetailSchema = z.object({
  contractor: contractorSchema.nullable(),
  bbb: bbbStatusSchema,
});
export type ContractorDetail = z.infer<typeof contractorDetailSchema>;

export const snapshotInfoSchema = z.object({
  baseUrl: z.string(),
  runId: z.string().nullable(),
  asOfDate: z.string().nullable(),
  tables: z.array(z.object({ name: z.string(), rows: z.number() })),
  bbbProfileCount: z.number(),
  limitations: z.array(z.string()),
});
export type SnapshotInfo = z.infer<typeof snapshotInfoSchema>;

export const appConfigSchema = z.object({
  county: z.object({
    name: z.string(),
    state: z.string(),
    fips: z.string(),
    center: geoPointSchema,
    bounds: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  }),
  defaults: z.object({
    radiusMiles: z.number(),
    roofAgeThresholdYears: z.number(),
    longOpenPermitDays: z.number(),
  }),
  agentEnabled: z.boolean(),
  llmProvider: z.string(),
});
export type AppConfig = z.infer<typeof appConfigSchema>;

// ---------------------------------------------------------------- CRM leads

export const leadStatusSchema = z.enum(LEAD_STATUSES);

export const leadNoteSchema = z.object({
  id: z.string(),
  text: z.string(),
  createdAt: z.string(),
});
export type LeadNote = z.infer<typeof leadNoteSchema>;

export const leadSourceSchema = z.enum(["map", "list", "permit", "agent"]);

/** Facts copied from the snapshot when the lead is created, so a lead stays readable across snapshots. */
export const leadSnapshotFactsSchema = z.object({
  address: z.string().nullable(),
  city: z.string().nullable(),
  zip: z.string().nullable(),
  latitude: z.number().nullable(),
  longitude: z.number().nullable(),
  ownerName: z.string().nullable(),
  mailingAddress: z.string().nullable(),
  roofAgeYears: z.number().nullable(),
  roofAgeBasis: z.string().nullable(),
  openRoofingPermitCount: z.number(),
  oldestOpenPermitDays: z.number().nullable(),
  contractorNames: z.array(z.string()),
  sourceUrl: z.string().nullable(),
  runId: z.string().nullable(),
});
export type LeadSnapshotFacts = z.infer<typeof leadSnapshotFactsSchema>;

export const leadSchema = z.object({
  id: z.string(),
  propId: z.string(),
  permitNumbers: z.array(z.string()),
  status: leadStatusSchema,
  source: leadSourceSchema,
  priority: z.enum(["high", "medium", "low"]),
  facts: leadSnapshotFactsSchema,
  notes: z.array(leadNoteSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Lead = z.infer<typeof leadSchema>;

export const createLeadInputSchema = z.object({
  propId: z.string().min(1),
  permitNumber: z.string().min(1).optional(),
  source: leadSourceSchema.default("map"),
  note: z.string().max(4000).optional(),
});
export type CreateLeadInput = z.input<typeof createLeadInputSchema>;

export const listLeadsInputSchema = z
  .object({
    status: leadStatusSchema.optional(),
  })
  .default({});

export const updateLeadStatusInputSchema = z.object({ id: z.string().min(1), status: leadStatusSchema });
export const addLeadNoteInputSchema = z.object({ id: z.string().min(1), text: z.string().min(1).max(4000) });
export const leadIdInputSchema = z.object({ id: z.string().min(1) });

// ---------------------------------------------------------------- Agent

export const agentAskInputSchema = z.object({
  question: z.string().min(3).max(2000),
  /** Optional map context so "near me"/"here" resolves to the current pin. */
  center: geoPointSchema.optional(),
  radiusMiles: radiusSchema.optional(),
});
export type AgentAskInput = z.infer<typeof agentAskInputSchema>;

export const citationSchema = z.object({
  kind: z.enum(["permit", "property", "source"]),
  id: z.string(),
  url: z.string().nullable(),
});
export type Citation = z.infer<typeof citationSchema>;

export const agentAnswerSchema = z.object({
  answer: z.string(),
  citations: z.array(citationSchema),
  assumptions: z.array(z.string()),
  missingData: z.array(z.string()),
  permits: z.array(permitSummarySchema),
  properties: z.array(propertySummarySchema),
  toolCalls: z.array(z.object({ tool: z.string(), input: z.string() })),
  model: z.string(),
});
export type AgentAnswer = z.infer<typeof agentAnswerSchema>;
