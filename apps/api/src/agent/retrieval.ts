import { cosineSimilarity, embedMany, type EmbeddingModel } from "ai";
import {
  formatOpenDuration,
  permitSearchInputSchema,
  propertySearchInputSchema,
  ROOF_AGE_BASIS_LABELS,
  type GeoPoint,
  type PermitSummary,
  type PropertySummary,
} from "@roofing-crm/shared";
import type { GeoPlace, SnapshotStore } from "../data/snapshot.js";

/**
 * Evidence collected while answering one question. Every permit/property the answer may cite must be
 * in here; citations in the final answer are validated against it (no hallucinated ids).
 */
export class EvidenceCollector {
  readonly permits = new Map<string, PermitSummary>();
  readonly properties = new Map<string, PropertySummary>();
  readonly assumptions = new Set<string>();
  readonly missingData = new Set<string>();
  readonly toolCalls: { tool: string; input: string }[] = [];

  addPermits(items: PermitSummary[]): void {
    for (const p of items) this.permits.set(p.permit_number, p);
  }
  addProperties(items: PropertySummary[]): void {
    for (const p of items) this.properties.set(p.prop_id, p);
  }
}

export type RetrievalDeps = {
  store: SnapshotStore;
  evidence: EvidenceCollector;
  defaults: {
    center: GeoPoint;
    radiusMiles: number;
    roofAgeThresholdYears: number;
    longOpenPermitDays: number;
  };
  embeddingModel?: EmbeddingModel | null;
};

/** Compact permit view handed to the LLM (full rows go to the UI via the evidence collector). */
export function compactPermit(p: PermitSummary) {
  return {
    permit_number: p.permit_number,
    prop_id: p.prop_id,
    status: p.status,
    is_open: p.is_open,
    open_days: p.open_days,
    open_for: formatOpenDuration(p.open_days),
    issued_date: p.issued_date,
    applied_date: p.applied_date,
    address: p.address,
    distance_miles: p.distance_miles === null ? null : Math.round(p.distance_miles * 100) / 100,
    description: p.description?.slice(0, 160) ?? null,
    contractor_name: p.contractor_name ?? p.contractor_company_name ?? p.contractor_full_name,
    contractor_bbb_rating: p.contractor_bbb_rating,
    source_url: p.source_url,
    permit_link: p.permit_link,
  };
}

export function compactProperty(p: PropertySummary) {
  return {
    prop_id: p.prop_id,
    address: [p.situs_address, p.situs_city, p.situs_zip].filter(Boolean).join(", "),
    distance_miles: p.distance_miles === null ? null : Math.round(p.distance_miles * 100) / 100,
    roof_age_years: p.roof_age_years,
    roof_age_basis: p.roof_age_basis,
    open_roofing_permit_count: p.open_roofing_permit_count,
    oldest_open_roofing_permit_days: p.oldest_open_roofing_permit_days,
    oldest_open_roofing_permit_number: p.oldest_open_roofing_permit_number,
    owner_name: p.owner_name,
  };
}

export async function geocodePlace(deps: RetrievalDeps, place: string): Promise<{ candidates: GeoPlace[] }> {
  deps.evidence.toolCalls.push({ tool: "geocode_place", input: place });
  const candidates = await deps.store.geocodePlace(place);
  const top = candidates[0];
  if (!top) {
    deps.evidence.missingData.add(`No Census place matched "${place}"; supply a pin on the map instead.`);
  } else {
    deps.evidence.assumptions.add(
      `"${place}" resolved to ${top.name ?? top.basename} (Census ${top.place_kind ?? "place"} ${top.geoid}); radius measured from its internal point (${top.latitude.toFixed(4)}, ${top.longitude.toFixed(4)}).`,
    );
  }
  return { candidates };
}

export type PermitQuery = {
  lat?: number;
  lng?: number;
  radiusMiles?: number;
  minOpenDays?: number;
  openOnly?: boolean;
  statuses?: string[];
  limit?: number;
};

export async function searchRoofingPermits(deps: RetrievalDeps, q: PermitQuery) {
  const center =
    q.lat !== undefined && q.lng !== undefined ? { lat: q.lat, lng: q.lng } : deps.defaults.center;
  const params = permitSearchInputSchema.parse({
    center,
    radiusMiles: q.radiusMiles ?? deps.defaults.radiusMiles,
    openOnly: q.openOnly ?? true,
    minOpenDays: q.minOpenDays ?? 0,
    statuses: q.statuses ?? [],
    sort: "open_days_desc",
    limit: Math.min(q.limit ?? 25, 100),
  });
  deps.evidence.toolCalls.push({ tool: "search_roofing_permits", input: JSON.stringify(params) });
  if (q.lat === undefined) {
    deps.evidence.assumptions.add(
      `No location given; searched around the default center (${center.lat.toFixed(4)}, ${center.lng.toFixed(4)}).`,
    );
  }
  if (params.minOpenDays > 0) {
    deps.evidence.assumptions.add(
      `"Open for" measured as days since issue (or application) date to the snapshot as-of date; threshold ${params.minOpenDays} days (~${(params.minOpenDays / 365).toFixed(1)} years).`,
    );
  }
  const { items, total } = await deps.store.searchPermits(params);
  deps.evidence.addPermits(items);
  notePermitGaps(deps, items);
  return {
    total_matches: total,
    returned: items.length,
    radius_miles: params.radiusMiles,
    permits: items.map(compactPermit),
  };
}

export type PropertyQuery = {
  lat?: number;
  lng?: number;
  radiusMiles?: number;
  minRoofAgeYears?: number;
  minOpenDays?: number;
  matchMode?: "either" | "aged_roof" | "open_permit" | "both";
  limit?: number;
};

export async function searchLeadProperties(deps: RetrievalDeps, q: PropertyQuery) {
  const center =
    q.lat !== undefined && q.lng !== undefined ? { lat: q.lat, lng: q.lng } : deps.defaults.center;
  const params = propertySearchInputSchema.parse({
    center,
    radiusMiles: q.radiusMiles ?? deps.defaults.radiusMiles,
    matchMode: q.matchMode ?? "aged_roof",
    minRoofAgeYears: q.minRoofAgeYears ?? deps.defaults.roofAgeThresholdYears,
    minOpenDays: q.minOpenDays ?? 0,
    sort: "priority",
    limit: Math.min(q.limit ?? 25, 100),
  });
  deps.evidence.toolCalls.push({ tool: "search_lead_properties", input: JSON.stringify(params) });
  const { items, total, stats } = await deps.store.searchProperties(params, deps.defaults.longOpenPermitDays);
  deps.evidence.addProperties(items);
  const inferred = items.filter((p) => p.roof_age_basis === "tcad_year_built").length;
  if (items.length && inferred) {
    deps.evidence.assumptions.add(
      `Roof age for ${inferred} of ${items.length} returned properties is inferred from appraisal year built (${ROOF_AGE_BASIS_LABELS.tcad_year_built}); no finaled roofing permit was found for them.`,
    );
  }
  deps.evidence.assumptions.add(
    `Roof age = snapshot as-of year minus roof year; threshold ${params.minRoofAgeYears} years.`,
  );
  return {
    total_matches: total,
    stats,
    returned: items.length,
    radius_miles: params.radiusMiles,
    properties: items.map(compactProperty),
  };
}

export async function searchPermitText(
  deps: RetrievalDeps,
  q: { query: string; lat?: number; lng?: number; radiusMiles?: number; openOnly?: boolean; limit?: number },
) {
  deps.evidence.toolCalls.push({ tool: "search_permit_text", input: JSON.stringify(q) });
  const center = q.lat !== undefined && q.lng !== undefined ? { lat: q.lat, lng: q.lng } : undefined;
  const limit = Math.min(q.limit ?? 20, 50);
  let hits = await deps.store.searchPermitText(q.query, {
    center,
    radiusMiles: center ? (q.radiusMiles ?? deps.defaults.radiusMiles) : undefined,
    openOnly: q.openOnly,
    limit: deps.embeddingModel ? Math.min(limit * 3, 150) : limit,
  });
  let retrieval = deps.store.ftsEnabled ? "bm25" : "substring";
  if (deps.embeddingModel && hits.length > 1) {
    hits = await rerankWithEmbeddings(deps.embeddingModel, q.query, hits);
    hits = hits.slice(0, limit);
    retrieval += "+embedding_rerank";
  }
  deps.evidence.addPermits(hits.map((h) => h.permit));
  notePermitGaps(
    deps,
    hits.map((h) => h.permit),
  );
  return {
    retrieval,
    returned: hits.length,
    hits: hits.map((h) => ({ score: h.score, ...compactPermit(h.permit) })),
  };
}

async function rerankWithEmbeddings<T extends { score: number; permit: PermitSummary }>(
  model: EmbeddingModel,
  query: string,
  hits: T[],
): Promise<T[]> {
  const docs = hits.map((h) =>
    [h.permit.description, h.permit.contractor_name, h.permit.permit_class, h.permit.address]
      .filter(Boolean)
      .join(" | "),
  );
  const { embeddings } = await embedMany({ model, values: [query, ...docs] });
  const [qv, ...dv] = embeddings;
  if (!qv) return hits;
  const maxBm25 = Math.max(...hits.map((h) => h.score), 1e-9);
  return hits
    .map((h, i) => {
      const cos = dv[i] ? cosineSimilarity(qv, dv[i]) : 0;
      return { ...h, score: Math.round((0.5 * (h.score / maxBm25) + 0.5 * cos) * 1000) / 1000 };
    })
    .sort((a, b) => b.score - a.score);
}

export async function getPropertyDetails(deps: RetrievalDeps, propId: string) {
  deps.evidence.toolCalls.push({ tool: "get_property_details", input: propId });
  const property = await deps.store.getProperty(propId);
  if (!property) return { error: `Property ${propId} not found in snapshot ${deps.store.info.runId ?? ""}` };
  const permits = await deps.store.permitsForProperty(propId);
  deps.evidence.addProperties([property]);
  deps.evidence.addPermits(permits);
  notePermitGaps(deps, permits);
  if (!property.last_deed_date)
    deps.evidence.missingData.add(
      `No deed date for ${propId} (${property.ownership_tenure_basis ?? "unknown basis"}); ownership tenure unknown.`,
    );
  return {
    property: {
      ...compactProperty(property),
      mailing: [property.mail_address, property.mail_city, property.mail_state, property.mail_zip]
        .filter(Boolean)
        .join(", "),
      owner_location_class: property.owner_location_class,
      year_built: property.year_built,
      last_deed_date: property.last_deed_date,
      ownership_tenure_basis: property.ownership_tenure_basis,
      roof_evidence_permit_number: property.roof_evidence_permit_number,
      roof_evidence_date: property.roof_evidence_date,
      parcel_source_url: property.parcel_source_url,
      parcel_collected_at: property.parcel_collected_at,
    },
    permits: permits.map(compactPermit),
  };
}

export function snapshotSummary(deps: RetrievalDeps) {
  deps.evidence.toolCalls.push({ tool: "get_snapshot_info", input: "" });
  return deps.store.info;
}

function notePermitGaps(deps: RetrievalDeps, permits: PermitSummary[]): void {
  if (!permits.length) return;
  if (deps.store.info.bbbProfileCount === 0) {
    deps.evidence.missingData.add("BBB ratings are not available in this snapshot (BBB harvest pending).");
  } else if (permits.some((p) => !p.contractor_bbb_rating)) {
    deps.evidence.missingData.add("Some contractors have no linked BBB profile.");
  }
  if (permits.some((p) => !p.contractor_name && !p.contractor_company_name && !p.contractor_full_name)) {
    deps.evidence.missingData.add("Some permits list no contractor.");
  }
}
