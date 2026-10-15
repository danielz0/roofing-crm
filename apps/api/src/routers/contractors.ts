import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { publicProcedure, router } from "../trpc.js";

export const contractorsRouter = router({
  get: publicProcedure.input(z.object({ contractorId: z.string().min(1) })).query(async ({ ctx, input }) => {
    const { store } = ctx.services;
    const detail = await store.contractorDetail(input.contractorId);
    if (!detail.contractor)
      throw new TRPCError({ code: "NOT_FOUND", message: `Contractor ${input.contractorId} not found` });
    return { ...detail, recentPermits: await store.contractorPermits(input.contractorId) };
  }),
});
