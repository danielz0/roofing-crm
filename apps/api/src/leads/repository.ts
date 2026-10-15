import type { Lead, LeadStatus } from "@roofing-crm/shared";

/**
 * Persistence boundary for CRM leads. Implementations: in-memory (tests), JSON file (local dev),
 * DynamoDB (AWS). One lead per property: the lead id is derived from the prop_id so creating a lead
 * twice for the same property is idempotent.
 */
export interface LeadRepository {
  readonly kind: "memory" | "file" | "dynamodb";
  get(id: string): Promise<Lead | null>;
  list(filter?: { status?: LeadStatus }): Promise<Lead[]>;
  /** Insert if absent. Returns `created: false` and the stored lead when it already exists. */
  createIfAbsent(lead: Lead): Promise<{ lead: Lead; created: boolean }>;
  /** Replace a lead; returns null when it does not exist. */
  put(lead: Lead): Promise<Lead | null>;
  delete(id: string): Promise<boolean>;
}

export function leadIdForProperty(propId: string): string {
  return `lead_${propId.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

export function sortLeads(leads: Lead[]): Lead[] {
  return [...leads].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
