import { randomUUID } from "node:crypto";
import {
  leadSignals,
  type CreateLeadInput,
  type Lead,
  type LeadStatus,
  type PermitSummary,
  type PropertyDetail,
} from "@roofing-crm/shared";
import type { LeadThresholds } from "@roofing-crm/shared";
import { leadIdForProperty, type LeadRepository } from "./repository.js";

export class LeadNotFoundError extends Error {
  constructor(id: string) {
    super(`Lead ${id} not found`);
  }
}

export class PropertyNotFoundError extends Error {
  constructor(propId: string) {
    super(`Property ${propId} not found in the current snapshot`);
  }
}

export type LeadFactsSource = {
  getProperty(propId: string): Promise<PropertyDetail | null>;
  permitsForProperty(propId: string): Promise<PermitSummary[]>;
  runId: string | null;
};

/** CRM lead use cases. Facts are always read from the snapshot server-side, never trusted from the client. */
export class LeadService {
  constructor(
    private readonly repo: LeadRepository,
    private readonly facts: LeadFactsSource,
    private readonly thresholds: LeadThresholds,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async create(input: Required<Pick<CreateLeadInput, "propId" | "source">> & CreateLeadInput) {
    const property = await this.facts.getProperty(input.propId);
    if (!property) throw new PropertyNotFoundError(input.propId);
    const permits = await this.facts.permitsForProperty(input.propId);
    const ts = this.now().toISOString();
    const signals = leadSignals(property, this.thresholds);
    const contractorNames = [
      ...new Set(permits.map((p) => p.contractor_name).filter((n): n is string => Boolean(n))),
    ].slice(0, 10);
    const mailing = [property.mail_address, property.mail_city, property.mail_state, property.mail_zip]
      .filter(Boolean)
      .join(", ");
    const lead: Lead = {
      id: leadIdForProperty(property.prop_id),
      propId: property.prop_id,
      permitNumbers: input.permitNumber ? [input.permitNumber] : [],
      status: "new",
      source: input.source,
      priority: signals.priority,
      facts: {
        address: property.situs_address,
        city: property.situs_city,
        zip: property.situs_zip,
        latitude: property.latitude,
        longitude: property.longitude,
        ownerName: property.owner_name,
        mailingAddress: mailing || null,
        roofAgeYears: property.roof_age_years,
        roofAgeBasis: property.roof_age_basis,
        openRoofingPermitCount: property.open_roofing_permit_count,
        oldestOpenPermitDays: property.oldest_open_roofing_permit_days,
        contractorNames,
        sourceUrl: property.parcel_source_url,
        runId: this.facts.runId,
      },
      notes: input.note ? [{ id: randomUUID(), text: input.note, createdAt: ts }] : [],
      createdAt: ts,
      updatedAt: ts,
    };
    const result = await this.repo.createIfAbsent(lead);
    if (!result.created && input.permitNumber && !result.lead.permitNumbers.includes(input.permitNumber)) {
      const merged = await this.repo.put({
        ...result.lead,
        permitNumbers: [...result.lead.permitNumbers, input.permitNumber],
        updatedAt: ts,
      });
      return { lead: merged ?? result.lead, created: false };
    }
    return result;
  }

  list(filter?: { status?: LeadStatus }) {
    return this.repo.list(filter);
  }

  async get(id: string): Promise<Lead> {
    const lead = await this.repo.get(id);
    if (!lead) throw new LeadNotFoundError(id);
    return lead;
  }

  async updateStatus(id: string, status: LeadStatus): Promise<Lead> {
    const lead = await this.get(id);
    const updated = await this.repo.put({ ...lead, status, updatedAt: this.now().toISOString() });
    if (!updated) throw new LeadNotFoundError(id);
    return updated;
  }

  async addNote(id: string, text: string): Promise<Lead> {
    const lead = await this.get(id);
    const ts = this.now().toISOString();
    const updated = await this.repo.put({
      ...lead,
      notes: [...lead.notes, { id: randomUUID(), text, createdAt: ts }],
      updatedAt: ts,
    });
    if (!updated) throw new LeadNotFoundError(id);
    return updated;
  }

  async delete(id: string): Promise<void> {
    if (!(await this.repo.delete(id))) throw new LeadNotFoundError(id);
  }
}
