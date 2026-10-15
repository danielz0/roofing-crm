import { ConditionalCheckFailedException, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import { leadSchema, type Lead, type LeadStatus } from "@roofing-crm/shared";
import { sortLeads, type LeadRepository } from "./repository.js";

/**
 * DynamoDB table layout (see infra): partition key `id` (string). GSI `byStatus` on
 * (`status`, `updatedAt`) serves status-filtered lists. Lead volume per tenant is small, so the
 * unfiltered list is a paginated Scan.
 */
export class DynamoLeadRepository implements LeadRepository {
  readonly kind: LeadRepository["kind"] = "dynamodb";
  private readonly doc: DynamoDBDocumentClient;

  constructor(
    private readonly tableName: string,
    client: DynamoDBClient = new DynamoDBClient({}),
  ) {
    this.doc = DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } });
  }

  async get(id: string): Promise<Lead | null> {
    const res = await this.doc.send(new GetCommand({ TableName: this.tableName, Key: { id } }));
    return res.Item ? leadSchema.parse(res.Item) : null;
  }

  async list(filter?: { status?: LeadStatus }): Promise<Lead[]> {
    const items: Record<string, unknown>[] = [];
    let startKey: Record<string, unknown> | undefined;
    do {
      const res = filter?.status
        ? await this.doc.send(
            new QueryCommand({
              TableName: this.tableName,
              IndexName: "byStatus",
              KeyConditionExpression: "#s = :s",
              ExpressionAttributeNames: { "#s": "status" },
              ExpressionAttributeValues: { ":s": filter.status },
              ExclusiveStartKey: startKey,
            }),
          )
        : await this.doc.send(new ScanCommand({ TableName: this.tableName, ExclusiveStartKey: startKey }));
      items.push(...((res.Items ?? []) as Record<string, unknown>[]));
      startKey = res.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (startKey);
    return sortLeads(items.map((i) => leadSchema.parse(i)));
  }

  async createIfAbsent(lead: Lead): Promise<{ lead: Lead; created: boolean }> {
    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.tableName,
          Item: lead,
          ConditionExpression: "attribute_not_exists(id)",
        }),
      );
      return { lead, created: true };
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) {
        const existing = await this.get(lead.id);
        if (existing) return { lead: existing, created: false };
      }
      throw err;
    }
  }

  async put(lead: Lead): Promise<Lead | null> {
    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.tableName,
          Item: lead,
          ConditionExpression: "attribute_exists(id)",
        }),
      );
      return lead;
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) return null;
      throw err;
    }
  }

  async delete(id: string): Promise<boolean> {
    const res = await this.doc.send(
      new DeleteCommand({ TableName: this.tableName, Key: { id }, ReturnValues: "ALL_OLD" }),
    );
    return Boolean(res.Attributes);
  }
}
