import { createTRPCClient, httpBatchLink } from "@trpc/client";
import type { AppRouter } from "@roofing-crm/api";
import type { inferRouterInputs, inferRouterOutputs } from "@trpc/server";

export type { AppRouter };
export type RouterInputs = inferRouterInputs<AppRouter>;
export type RouterOutputs = inferRouterOutputs<AppRouter>;

/** Normalize an API base URL to the tRPC endpoint (`<base>/trpc`). */
export function trpcUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return trimmed.endsWith("/trpc") ? trimmed : `${trimmed}/trpc`;
}

/** Vanilla typed client (scripts, tests, non-React consumers). */
export function createApiClient(baseUrl: string) {
  return createTRPCClient<AppRouter>({
    links: [httpBatchLink({ url: trpcUrl(baseUrl), maxURLLength: 4000 })],
  });
}
