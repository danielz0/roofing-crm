import { DEFAULT_LONG_OPEN_PERMIT_DAYS, DEFAULT_ROOF_AGE_THRESHOLD_YEARS } from "./constants.js";
import type { LeadMatchMode, PropertySummary } from "./schemas.js";

export type LeadThresholds = {
  roofAgeThresholdYears: number;
  longOpenPermitDays: number;
  minOpenDays?: number;
};

export const DEFAULT_THRESHOLDS: LeadThresholds = {
  roofAgeThresholdYears: DEFAULT_ROOF_AGE_THRESHOLD_YEARS,
  longOpenPermitDays: DEFAULT_LONG_OPEN_PERMIT_DAYS,
};

export type LeadSignals = {
  agedRoof: boolean;
  openPermit: boolean;
  longOpenPermit: boolean;
  /** Roof age comes from appraisal year built or no evidence at all, not a roofing permit. */
  roofAgeInferred: boolean;
  priority: "high" | "medium" | "low";
  /** Sort key: higher = more urgent. Transparent and deterministic (see `leadScore`). */
  score: number;
  reasons: string[];
};

type SignalInput = Pick<
  PropertySummary,
  "roof_age_years" | "roof_age_basis" | "open_roofing_permit_count" | "oldest_open_roofing_permit_days"
>;

/**
 * Classify a property as a roofing lead. Priority rules:
 * - high: a long-open roofing permit, or an aged roof that also has an open roofing permit
 * - medium: an aged roof, or any open roofing permit
 * - low: neither
 */
export function leadSignals(p: SignalInput, t: LeadThresholds = DEFAULT_THRESHOLDS): LeadSignals {
  const minOpen = t.minOpenDays ?? 0;
  const openDays = p.oldest_open_roofing_permit_days;
  const agedRoof = p.roof_age_years !== null && p.roof_age_years >= t.roofAgeThresholdYears;
  const openPermit = p.open_roofing_permit_count > 0 && (openDays ?? 0) >= minOpen;
  const longOpenPermit = openPermit && openDays !== null && openDays >= t.longOpenPermitDays;
  const roofAgeInferred = p.roof_age_basis === "tcad_year_built" || p.roof_age_basis === "no_evidence";
  const reasons: string[] = [];
  if (agedRoof) reasons.push(`Roof ~${p.roof_age_years} yrs (>= ${t.roofAgeThresholdYears})`);
  if (longOpenPermit) reasons.push(`Roofing permit open ${openDays} days`);
  else if (openPermit) reasons.push(`Open roofing permit${openDays !== null ? ` (${openDays} days)` : ""}`);
  const priority =
    longOpenPermit || (agedRoof && openPermit) ? "high" : agedRoof || openPermit ? "medium" : "low";
  return { agedRoof, openPermit, longOpenPermit, roofAgeInferred, priority, score: leadScore(p, t), reasons };
}

/**
 * Score = open-permit years x 10 (capped at 100) + years the roof is past threshold (capped at 50)
 * + 25 when both signals are present. Only used for ordering, never shown as a probability.
 */
export function leadScore(p: SignalInput, t: LeadThresholds = DEFAULT_THRESHOLDS): number {
  const openDays = p.open_roofing_permit_count > 0 ? (p.oldest_open_roofing_permit_days ?? 0) : 0;
  const openPart = Math.min(100, (openDays / 365) * 10);
  const roofOver = p.roof_age_years !== null ? Math.max(0, p.roof_age_years - t.roofAgeThresholdYears) : 0;
  const roofAged = p.roof_age_years !== null && p.roof_age_years >= t.roofAgeThresholdYears;
  const roofPart = roofAged ? Math.min(50, roofOver + 1) : 0;
  const both = roofAged && p.open_roofing_permit_count > 0 ? 25 : 0;
  return Math.round((openPart + roofPart + both) * 100) / 100;
}

export function matchesMode(
  signals: Pick<LeadSignals, "agedRoof" | "openPermit">,
  mode: LeadMatchMode,
): boolean {
  switch (mode) {
    case "aged_roof":
      return signals.agedRoof;
    case "open_permit":
      return signals.openPermit;
    case "both":
      return signals.agedRoof && signals.openPermit;
    case "either":
      return signals.agedRoof || signals.openPermit;
  }
}

/** Human-readable duration for open permits, e.g. 1460 -> "4.0 yrs". */
export function formatOpenDuration(days: number | null | undefined): string {
  if (days === null || days === undefined) return "n/a";
  if (days < 60) return `${days} days`;
  if (days < 365) return `${(days / 30.4).toFixed(1)} mo`;
  return `${(days / 365).toFixed(1)} yrs`;
}
