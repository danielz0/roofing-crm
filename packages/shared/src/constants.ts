/**
 * Product defaults. Every value here is a *default*: the API overrides them from environment
 * variables (see `.env.example`) and serves the effective values to the web app via `meta.config`.
 */
export const DEFAULT_COUNTY = {
  name: "Travis County",
  state: "TX",
  fips: "48453",
  /** Default map center: downtown Austin (Travis County seat). */
  center: { lat: 30.2672, lng: -97.7431 },
  /** Approximate county extent used only to frame the initial map view: [west, south, east, north]. */
  bounds: [-98.18, 30.02, -97.36, 30.63] as [number, number, number, number],
} as const;

export const DEFAULT_ROOF_AGE_THRESHOLD_YEARS = 15;
export const DEFAULT_RADIUS_MILES = 3;
export const MAX_RADIUS_MILES = 50;
/** An open roofing permit older than this is flagged "long-open" (configurable). */
export const DEFAULT_LONG_OPEN_PERMIT_DAYS = 365;
export const MAX_RESULTS = 2000;

export const LEAD_STATUSES = ["new", "contacted", "qualified", "won", "lost"] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

export const LEAD_STATUS_LABELS: Record<LeadStatus, string> = {
  new: "New",
  contacted: "Contacted",
  qualified: "Qualified",
  won: "Won",
  lost: "Lost",
};

export const ROOF_AGE_BASIS_LABELS: Record<string, string> = {
  final_roof_replacement_permit: "Finaled roof-replacement permit",
  final_new_construction_permit: "Finaled new-construction permit",
  tcad_year_built: "Appraisal district year built (no roof permit found)",
  no_evidence: "No roof-age evidence",
};

/** Sections shown disabled in the UI to signal the product roadmap beyond lead identification. */
export const FUTURE_SECTIONS = [
  {
    id: "outreach",
    label: "Outreach campaigns",
    description: "Mail, SMS and call sequences to owners (messaging deferred).",
  },
  {
    id: "estimates",
    label: "Estimates & quotes",
    description: "Roof measurements, material takeoffs and proposals.",
  },
  {
    id: "insurance",
    label: "Insurance claims",
    description: "Storm events, adjuster scheduling and claim tracking.",
  },
  { id: "crews", label: "Crew scheduling", description: "Job calendar and crew assignment." },
  { id: "analytics", label: "Analytics", description: "Pipeline conversion and territory performance." },
] as const;
