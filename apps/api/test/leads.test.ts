import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ConditionalCheckFailedException, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it } from "vitest";
import type { Lead } from "@roofing-crm/shared";
import { DynamoLeadRepository } from "../src/leads/dynamo.js";
import { FileLeadRepository } from "../src/leads/file.js";
import { testCaller } from "./helpers.js";

describe("leads router (CRM lifecycle)", () => {
  it("creates a lead from a property + permit with snapshot facts", async () => {
    const { caller } = await testCaller();
    const { lead, created } = await caller.leads.create({
      propId: "P1",
      permitNumber: "A-OPEN",
      source: "permit",
      note: "Long-open permit",
    });
    expect(created).toBe(true);
    expect(lead).toMatchObject({
      id: "lead_P1",
      propId: "P1",
      status: "new",
      source: "permit",
      priority: "high",
      permitNumbers: ["A-OPEN"],
      facts: {
        address: "100 MAIN ST",
        roofAgeYears: 25,
        roofAgeBasis: "tcad_year_built",
        oldestOpenPermitDays: 2000,
        runId: "fixture-run-0001",
      },
    });
    expect(lead.facts.contractorNames).toEqual(["Acme Roofing LLC"]);
    expect(lead.notes).toHaveLength(1);
  });

  it("is idempotent per property and merges permit numbers", async () => {
    const { caller } = await testCaller();
    await caller.leads.create({ propId: "P3" });
    const again = await caller.leads.create({ propId: "P3", permitNumber: "E-EXPIRED" });
    expect(again.created).toBe(false);
    expect(again.lead.permitNumbers).toEqual(["E-EXPIRED"]);
    expect(await caller.leads.list({})).toHaveLength(1);
  });

  it("updates status, adds notes, filters and deletes", async () => {
    const { caller } = await testCaller();
    const { lead } = await caller.leads.create({ propId: "P4" });
    await caller.leads.create({ propId: "P1" });
    await caller.leads.updateStatus({ id: lead.id, status: "contacted" });
    const noted = await caller.leads.addNote({ id: lead.id, text: "Left voicemail" });
    expect(noted.status).toBe("contacted");
    expect(noted.notes.map((n) => n.text)).toEqual(["Left voicemail"]);
    expect((await caller.leads.list({ status: "contacted" })).map((l) => l.id)).toEqual([lead.id]);
    await caller.leads.delete({ id: lead.id });
    expect((await caller.leads.list({})).map((l) => l.id)).toEqual(["lead_P1"]);
  });

  it("returns NOT_FOUND for unknown leads and properties", async () => {
    const { caller } = await testCaller();
    await expect(caller.leads.updateStatus({ id: "lead_nope", status: "won" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(caller.leads.create({ propId: "NOPE" })).rejects.toBeInstanceOf(TRPCError);
    await expect(caller.leads.create({ propId: "NOPE" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects invalid statuses", async () => {
    const { caller } = await testCaller();
    // @ts-expect-error invalid enum on purpose
    await expect(caller.leads.updateStatus({ id: "lead_P1", status: "archived" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });
});

describe("FileLeadRepository", () => {
  it("persists across instances", async () => {
    const file = path.join(await mkdtemp(path.join(tmpdir(), "leads-")), "leads.json");
    const { caller } = await testCaller({ leadRepository: await FileLeadRepository.open(file) });
    await caller.leads.create({ propId: "P1" });
    const reopened = await FileLeadRepository.open(file);
    expect((await reopened.list()).map((l) => l.id)).toEqual(["lead_P1"]);
  });
});

describe("DynamoLeadRepository", () => {
  const ddb = mockClient(DynamoDBDocumentClient);
  beforeEach(() => ddb.reset());
  const lead: Lead = {
    id: "lead_P1",
    propId: "P1",
    permitNumbers: [],
    status: "new",
    source: "map",
    priority: "high",
    facts: {
      address: null,
      city: null,
      zip: null,
      latitude: null,
      longitude: null,
      ownerName: null,
      mailingAddress: null,
      roofAgeYears: null,
      roofAgeBasis: null,
      openRoofingPermitCount: 0,
      oldestOpenPermitDays: null,
      contractorNames: [],
      sourceUrl: null,
      runId: null,
    },
    notes: [],
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  };
  const repo = () => new DynamoLeadRepository("leads", new DynamoDBClient({ region: "us-east-2" }));

  it("conditional create returns existing on conflict", async () => {
    ddb.on(PutCommand).rejects(new ConditionalCheckFailedException({ message: "exists", $metadata: {} }));
    ddb.on(GetCommand).resolves({ Item: { ...lead, status: "qualified" } });
    const res = await repo().createIfAbsent(lead);
    expect(res).toMatchObject({ created: false, lead: { status: "qualified" } });
    expect(ddb.commandCalls(PutCommand)[0]?.args[0].input.ConditionExpression).toBe(
      "attribute_not_exists(id)",
    );
  });

  it("queries the status index", async () => {
    ddb.on(QueryCommand).resolves({ Items: [lead] });
    expect(await repo().list({ status: "new" })).toHaveLength(1);
    expect(ddb.commandCalls(QueryCommand)[0]?.args[0].input.IndexName).toBe("byStatus");
  });

  it("put on a missing lead returns null; delete reports existence", async () => {
    ddb.on(PutCommand).rejects(new ConditionalCheckFailedException({ message: "missing", $metadata: {} }));
    expect(await repo().put(lead)).toBeNull();
    ddb.on(DeleteCommand).resolves({ Attributes: lead });
    expect(await repo().delete("lead_P1")).toBe(true);
  });
});
