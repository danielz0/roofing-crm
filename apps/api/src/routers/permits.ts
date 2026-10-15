import { z } from "zod";
import { permitSearchInputSchema } from "@roofing-crm/shared";
import { TRPCError } from "@trpc/server";
import { publicProcedure, router } from "../trpc.js";

export const permitsRouter = router({
  /** Roofing permits within a radius; default open only, longest-open first. */
  search: publicProcedure.input(permitSearchInputSchema).query(async ({ ctx, input }) => {
    const res = await ctx.services.store.searchPermits(input);
    return { ...res, truncated: res.total > res.items.length };
  }),

  statuses: publicProcedure.query(({ ctx }) => ctx.services.store.permitStatuses()),

  get: publicProcedure.input(z.object({ permitNumber: z.string().min(1) })).query(async ({ ctx, input }) => {
    const { store } = ctx.services;
    const permit = await store.getPermit(input.permitNumber);
    if (!permit)
      throw new TRPCError({ code: "NOT_FOUND", message: `Permit ${input.permitNumber} not found` });
    const contractor = await store.contractorDetail(permit.contractor_id);
    return {
      permit,
      contractor,
      provenance: {
        runId: store.info.runId,
        sourceUrl: permit.source_url,
        permitLink: permit.permit_link,
        collectedAt: permit.collected_at,
        rawSha256: permit.raw_sha256,
        sourceId: permit.source_id,
      },
    };
  }),

  /** BM25 full-text search over permit descriptions and contractor names. */
  textSearch: publicProcedure
    .input(
      z.object({
        query: z.string().min(2).max(200),
        openOnly: z.boolean().default(false),
        limit: z.number().int().min(1).max(100).default(25),
      }),
    )
    .query(({ ctx, input }) =>
      ctx.services.store.searchPermitText(input.query, { openOnly: input.openOnly, limit: input.limit }),
    ),
});
