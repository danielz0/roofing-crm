import { describe, expect, it } from "vitest";
import {
  boundingBox,
  circleRing,
  formatOpenDuration,
  haversineMiles,
  leadScore,
  leadSignals,
  matchesMode,
  propertySearchInputSchema,
} from "../src/index.js";

const austin = { lat: 30.2672, lng: -97.7431 };

describe("geo", () => {
  it("haversine distance Austin -> Round Rock is ~17-18 miles", () => {
    const d = haversineMiles(austin, { lat: 30.5083, lng: -97.6789 });
    expect(d).toBeGreaterThan(16);
    expect(d).toBeLessThan(19);
  });

  it("is zero for identical points", () => {
    expect(haversineMiles(austin, austin)).toBe(0);
  });

  it("bounding box contains every point of the circle", () => {
    const r = 5;
    const box = boundingBox(austin, r);
    for (const [lng, lat] of circleRing(austin, r, 128)) {
      expect(lat).toBeGreaterThanOrEqual(box.minLat);
      expect(lat).toBeLessThanOrEqual(box.maxLat);
      expect(lng).toBeGreaterThanOrEqual(box.minLng);
      expect(lng).toBeLessThanOrEqual(box.maxLng);
      expect(haversineMiles(austin, { lat, lng })).toBeCloseTo(r, 3);
    }
  });
});

const base = {
  roof_age_years: null as number | null,
  roof_age_basis: "no_evidence" as string | null,
  open_roofing_permit_count: 0,
  oldest_open_roofing_permit_days: null as number | null,
};

describe("lead signals", () => {
  it("flags an aged roof at exactly the threshold", () => {
    const s = leadSignals({ ...base, roof_age_years: 15, roof_age_basis: "tcad_year_built" });
    expect(s.agedRoof).toBe(true);
    expect(s.roofAgeInferred).toBe(true);
    expect(s.priority).toBe("medium");
  });

  it("does not flag a younger roof", () => {
    expect(leadSignals({ ...base, roof_age_years: 14 }).agedRoof).toBe(false);
  });

  it("long-open permit is high priority", () => {
    const s = leadSignals({ ...base, open_roofing_permit_count: 1, oldest_open_roofing_permit_days: 2000 });
    expect(s.longOpenPermit).toBe(true);
    expect(s.priority).toBe("high");
  });

  it("respects minOpenDays", () => {
    const p = { ...base, open_roofing_permit_count: 1, oldest_open_roofing_permit_days: 100 };
    expect(
      leadSignals(p, { roofAgeThresholdYears: 15, longOpenPermitDays: 365, minOpenDays: 200 }).openPermit,
    ).toBe(false);
  });

  it("scores long-open + aged above aged only", () => {
    const aged = { ...base, roof_age_years: 30 };
    const both = { ...aged, open_roofing_permit_count: 1, oldest_open_roofing_permit_days: 1825 };
    expect(leadScore(both)).toBeGreaterThan(leadScore(aged));
  });

  it("match modes", () => {
    expect(matchesMode({ agedRoof: true, openPermit: false }, "either")).toBe(true);
    expect(matchesMode({ agedRoof: true, openPermit: false }, "both")).toBe(false);
    expect(matchesMode({ agedRoof: false, openPermit: true }, "open_permit")).toBe(true);
    expect(matchesMode({ agedRoof: false, openPermit: true }, "aged_roof")).toBe(false);
  });

  it("formats durations", () => {
    expect(formatOpenDuration(10)).toBe("10 days");
    expect(formatOpenDuration(1825)).toBe("5.0 yrs");
    expect(formatOpenDuration(null)).toBe("n/a");
  });
});

describe("schemas", () => {
  it("applies defaults (15-year threshold)", () => {
    const parsed = propertySearchInputSchema.parse({ center: austin });
    expect(parsed.minRoofAgeYears).toBe(15);
    expect(parsed.matchMode).toBe("either");
  });

  it("rejects radius beyond max", () => {
    expect(() => propertySearchInputSchema.parse({ center: austin, radiusMiles: 500 })).toThrow();
  });
});
