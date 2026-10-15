import type { GeoPoint, LeadMatchMode } from "@roofing-crm/shared";

export type CenterSource = "default" | "gps" | "pin" | "agent";

export type Filters = {
  center: GeoPoint;
  centerSource: CenterSource;
  radiusMiles: number;
  minRoofAgeYears: number;
  matchMode: LeadMatchMode;
  minOpenYears: number;
  permitStatuses: string[];
  propertySort: "priority" | "open_days_desc" | "roof_age_desc" | "distance_asc";
};

export type Selection =
  { kind: "property"; propId: string } | { kind: "permit"; permitNumber: string } | null;
