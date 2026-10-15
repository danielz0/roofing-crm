import {
  addLeadNoteInputSchema,
  createLeadInputSchema,
  leadIdInputSchema,
  listLeadsInputSchema,
  updateLeadStatusInputSchema,
} from "@roofing-crm/shared";
import { metrics, MetricUnit } from "../observability.js";
import { publicProcedure, router } from "../trpc.js";

export const leadsRouter = router({
  list: publicProcedure.input(listLeadsInputSchema).query(({ ctx, input }) => ctx.services.leads.list(input)),
  get: publicProcedure.input(leadIdInputSchema).query(({ ctx, input }) => ctx.services.leads.get(input.id)),
  /** Create a lead from a property (optionally a specific permit). Idempotent per property. */
  create: publicProcedure.input(createLeadInputSchema).mutation(async ({ ctx, input }) => {
    const res = await ctx.services.leads.create(input);
    if (res.created) metrics.addMetric("LeadCreated", MetricUnit.Count, 1);
    return res;
  }),
  updateStatus: publicProcedure
    .input(updateLeadStatusInputSchema)
    .mutation(({ ctx, input }) => ctx.services.leads.updateStatus(input.id, input.status)),
  addNote: publicProcedure
    .input(addLeadNoteInputSchema)
    .mutation(({ ctx, input }) => ctx.services.leads.addNote(input.id, input.text)),
  delete: publicProcedure.input(leadIdInputSchema).mutation(async ({ ctx, input }) => {
    await ctx.services.leads.delete(input.id);
    return { id: input.id, deleted: true };
  }),
});
