import type { Lead, LeadStatus } from "@roofing-crm/shared";
import { sortLeads, type LeadRepository } from "./repository.js";

export class InMemoryLeadRepository implements LeadRepository {
  readonly kind: LeadRepository["kind"] = "memory";
  protected readonly leads = new Map<string, Lead>();

  async get(id: string): Promise<Lead | null> {
    return structuredClone(this.leads.get(id) ?? null);
  }

  async list(filter?: { status?: LeadStatus }): Promise<Lead[]> {
    const all = [...this.leads.values()].filter((l) => !filter?.status || l.status === filter.status);
    return structuredClone(sortLeads(all));
  }

  async createIfAbsent(lead: Lead): Promise<{ lead: Lead; created: boolean }> {
    const existing = this.leads.get(lead.id);
    if (existing) return { lead: structuredClone(existing), created: false };
    this.leads.set(lead.id, structuredClone(lead));
    await this.persist();
    return { lead: structuredClone(lead), created: true };
  }

  async put(lead: Lead): Promise<Lead | null> {
    if (!this.leads.has(lead.id)) return null;
    this.leads.set(lead.id, structuredClone(lead));
    await this.persist();
    return structuredClone(lead);
  }

  async delete(id: string): Promise<boolean> {
    const deleted = this.leads.delete(id);
    if (deleted) await this.persist();
    return deleted;
  }

  protected async persist(): Promise<void> {
    // in-memory: nothing to do
  }
}
