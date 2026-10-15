import { httpBatchLink } from "@trpc/client";
import { createTRPCReact } from "@trpc/react-query";
import type { AppRouter } from "@roofing-crm/api";
import { trpcUrl } from "./index.js";

export { trpcUrl };
export type { RouterInputs, RouterOutputs } from "./index.js";

/** Typed React hooks shared by every frontend app. */
export const trpc = createTRPCReact<AppRouter>();

export function createReactClient(baseUrl: string) {
  return trpc.createClient({ links: [httpBatchLink({ url: trpcUrl(baseUrl), maxURLLength: 4000 })] });
}
