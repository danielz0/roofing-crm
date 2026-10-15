import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "maplibre-gl/dist/maplibre-gl.css";
import { createReactClient, trpc } from "@roofing-crm/api-client/react";
import { App } from "./App";
import { resolveApiUrl } from "./runtimeConfig";
import "./styles.css";

const apiUrl = await resolveApiUrl();
const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1, staleTime: 60_000 } },
});
const trpcClient = createReactClient(apiUrl);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <App apiUrl={apiUrl} />
      </QueryClientProvider>
    </trpc.Provider>
  </StrictMode>,
);
