import { z } from "zod";
import { leadSignals, propertySearchInputSchema } from "@roofing-crm/shared";
import { TRPCError } from "@trpc/server";
import { publicProcedure, router } from "../trpc.js";

export const propertiesRouter = router({
  /** Lead candidates within a radius: aged roofs and/or open roofing permits. */
  search: publicProcedure.input(propertySearchInputSchema).query(async ({ ctx, input }) => {
    const { thresholds, store } = ctx.services;
    const { items, total, stats } = await store.searchProperties(input, thresholds.longOpenPermitDays);
    const t = {
      roofAgeThresholdYears: input.minRoofAgeYears,
      longOpenPermitDays: thresholds.longOpenPermitDays,
      minOpenDays: input.minOpenDays,
    };
    return {
      items: items.map((p) => ({ ...p, signals: leadSignals(p, t) })),
      total,
      truncated: total > items.length,
      stats,
      runId: store.info.runId,
    };
  }),

  /** Property detail: owner/mailing, roof-age evidence, roofing permits with contractor + BBB status. */
  get: publicProcedure.input(z.object({ propId: z.string().min(1) })).query(async ({ ctx, input }) => {
    const { store, thresholds } = ctx.services;
    const property = await store.getProperty(input.propId);
    if (!property) throw new TRPCError({ code: "NOT_FOUND", message: `Property ${input.propId} not found` });
    const permits = await store.permitsForProperty(input.propId);
    const contractorIds = [
      ...new Set(permits.map((p) => p.contractor_id).filter((id): id is string => Boolean(id))),
    ];
    const contractors = await Promise.all(contractorIds.map((id) => store.contractorDetail(id)));
    return {
      property,
      signals: leadSignals(property, thresholds),
      permits,
      contractors,
      provenance: {
        runId: store.info.runId,
        asOfDate: store.info.asOfDate,
        sourceUrl: property.parcel_source_url,
        collectedAt: property.parcel_collected_at,
        rawSha256: property.parcel_raw_sha256,
        sourceId: property.parcel_source_id,
      },
    };
  }),
});
