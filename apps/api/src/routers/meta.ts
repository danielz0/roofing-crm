import { FUTURE_SECTIONS } from "@roofing-crm/shared";
import { publicProcedure, router } from "../trpc.js";

export const metaRouter = router({
  config: publicProcedure.query(({ ctx }) => ctx.services.appConfig),
  snapshot: publicProcedure.query(({ ctx }) => ({
    ...ctx.services.store.info,
    ftsEnabled: ctx.services.store.ftsEnabled,
  })),
  futureSections: publicProcedure.query(() => FUTURE_SECTIONS.map((s) => ({ ...s, enabled: false }))),
  health: publicProcedure.query(({ ctx }) => ({ ok: true, runId: ctx.services.store.info.runId })),
});
