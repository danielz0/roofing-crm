import { formatOpenDuration, MAX_RADIUS_MILES } from "@roofing-crm/shared";
import {
  geocodePlace,
  searchLeadProperties,
  searchPermitText,
  searchRoofingPermits,
  type RetrievalDeps,
} from "./retrieval.js";

const WORD_NUMBERS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  fifteen: 15,
  twenty: 20,
  thirty: 30,
};

const NUM = String.raw`(\d+(?:\.\d+)?|${Object.keys(WORD_NUMBERS).join("|")})`;

function toNumber(token: string | undefined): number | null {
  if (!token) return null;
  const t = token.toLowerCase();
  return WORD_NUMBERS[t] ?? (Number.isFinite(Number(t)) ? Number(t) : null);
}

export type QuestionPlan = {
  intent: "permits" | "roofs" | "both";
  radiusMiles: number | null;
  minOpenDays: number | null;
  minRoofAgeYears: number | null;
  place: string | null;
  textQuery: string | null;
  openOnly: boolean;
};

/**
 * Deterministic parse of a natural-language lead question. Used when no LLM is configured
 * (LLM_PROVIDER=none) so the demo and tests still exercise the same retrieval tools.
 */
export function parseQuestion(question: string): QuestionPlan {
  const q = question.replace(/\s+/g, " ").trim();
  const lower = q.toLowerCase();

  const radius = new RegExp(`${NUM}\\s*-?\\s*(?:miles?|mi)\\b`, "i").exec(q);
  const radiusMiles = radius ? Math.min(toNumber(radius[1]) ?? 0, MAX_RADIUS_MILES) || null : null;

  let minOpenDays: number | null = null;
  let minRoofAgeYears: number | null = null;
  const dur = new RegExp(`${NUM}\\s*\\+?\\s*(years?|yrs?|months?|days?)`, "i").exec(q);
  const mentionsPermit = /permit/i.test(q);
  const mentionsRoofAge = /\broofs?\b|roof age|aged|old roof/i.test(q) && !/roofing permit/i.test(lower);
  if (dur) {
    const n = toNumber(dur[1]) ?? 0;
    const unit = (dur[2] ?? "").toLowerCase();
    const days = unit.startsWith("y") ? n * 365 : unit.startsWith("m") ? Math.round(n * 30.4) : n;
    if (mentionsPermit && !mentionsRoofAge) minOpenDays = Math.round(days);
    else if (mentionsRoofAge && !mentionsPermit) minRoofAgeYears = Math.round(days / 365);
    else if (mentionsPermit) minOpenDays = Math.round(days);
    else minRoofAgeYears = Math.round(days / 365);
  }

  const placeMatch =
    /\b(?:near|around|in|of|close to|outside)\s+(?:the\s+)?(?:city\s+of\s+)?([A-Z][A-Za-z.'-]*(?:\s+[A-Z][A-Za-z.'-]*){0,3})/.exec(
      q,
    );
  const place = placeMatch?.[1]?.replace(/\s+(TX|Texas)$/i, "").trim() ?? null;

  const quoted = /["“']([^"”']{2,60})["”']/.exec(q);
  const contractor = /\b(?:by|contractor)\s+([A-Z][A-Za-z0-9&.'-]*(?:\s+[A-Z][A-Za-z0-9&.'-]*){0,4})/.exec(q);
  const textQuery = quoted?.[1] ?? contractor?.[1] ?? null;

  const intent: QuestionPlan["intent"] =
    mentionsPermit && !mentionsRoofAge ? "permits" : mentionsRoofAge && !mentionsPermit ? "roofs" : "both";
  const openOnly = !/\b(all|any|closed|final(ed)?|expired)\b/i.test(lower) || /\bopen\b/i.test(lower);
  return { intent, radiusMiles, minOpenDays, minRoofAgeYears, place, textQuery, openOnly };
}

export async function planQuestion(deps: RetrievalDeps, question: string): Promise<string> {
  const plan = parseQuestion(question);
  const lines: string[] = [
    "Retrieval-only mode (no LLM configured): results come straight from the snapshot tools.",
  ];
  let center = deps.defaults.center;
  let where = `the map center (${center.lat.toFixed(4)}, ${center.lng.toFixed(4)})`;

  if (plan.place) {
    const { candidates } = await geocodePlace(deps, plan.place);
    const top = candidates[0];
    if (top) {
      center = { lat: top.latitude, lng: top.longitude };
      where = top.name ?? top.basename ?? plan.place;
    } else {
      lines.push(
        `Could not resolve "${plan.place}" to a known place; searched around the map center instead.`,
      );
    }
  }
  const radiusMiles = plan.radiusMiles ?? deps.defaults.radiusMiles;
  if (!plan.radiusMiles) deps.evidence.assumptions.add(`No radius given; used ${radiusMiles} miles.`);

  if (plan.textQuery) {
    const res = await searchPermitText(deps, {
      query: plan.textQuery,
      lat: center.lat,
      lng: center.lng,
      radiusMiles,
      openOnly: plan.openOnly,
      limit: 10,
    });
    lines.push(
      `Text search for "${plan.textQuery}" (${res.retrieval}) within ${radiusMiles} mi of ${where}: ${res.returned} hit(s).`,
    );
    for (const h of res.hits.slice(0, 10)) {
      lines.push(
        `- ${h.permit_number} (${h.status ?? "status n/a"}, open ${h.open_for}) ${h.address ?? ""} - ${h.contractor_name ?? "no contractor"}`,
      );
    }
  }

  if (plan.intent !== "roofs") {
    const res = await searchRoofingPermits(deps, {
      lat: center.lat,
      lng: center.lng,
      radiusMiles,
      minOpenDays: plan.minOpenDays ?? 0,
      openOnly: plan.openOnly,
      limit: 25,
    });
    const label = plan.minOpenDays
      ? ` open at least ${formatOpenDuration(plan.minOpenDays)}`
      : plan.openOnly
        ? " currently open"
        : "";
    lines.push(
      `${res.total_matches} roofing permit(s)${label} within ${radiusMiles} mi of ${where}. Longest open first:`,
    );
    for (const p of res.permits.slice(0, 10)) {
      lines.push(
        `- ${p.permit_number}: ${p.address ?? "address n/a"} - ${p.status ?? "status n/a"}, open ${p.open_for}, contractor ${p.contractor_name ?? "n/a"}${p.prop_id ? ` (prop ${p.prop_id})` : ""}`,
      );
    }
  }

  if (plan.intent !== "permits") {
    const res = await searchLeadProperties(deps, {
      lat: center.lat,
      lng: center.lng,
      radiusMiles,
      minRoofAgeYears: plan.minRoofAgeYears ?? deps.defaults.roofAgeThresholdYears,
      matchMode: plan.intent === "roofs" ? "aged_roof" : "either",
      limit: 25,
    });
    lines.push(
      `${res.total_matches} propert${res.total_matches === 1 ? "y" : "ies"} within ${radiusMiles} mi of ${where} match (aged roofs: ${res.stats.agedRoofs}, with open roofing permits: ${res.stats.withOpenPermits}). Top by priority:`,
    );
    for (const p of res.properties.slice(0, 10)) {
      lines.push(
        `- prop ${p.prop_id}: ${p.address || "address n/a"} - roof ~${p.roof_age_years ?? "?"} yrs (${p.roof_age_basis ?? "n/a"}), open roofing permits: ${p.open_roofing_permit_count}`,
      );
    }
  }
  return lines.join("\n");
}
