/**
 * The API URL is resolved at runtime so one build can be promoted across environments:
 * 1. /config.json (written by the CDK deployment next to the static assets)
 * 2. VITE_API_URL (build-time, e.g. local dev)
 * 3. http://localhost:4000 (local API dev server)
 */
export async function resolveApiUrl(): Promise<string> {
  try {
    const res = await fetch("/config.json", { cache: "no-store" });
    if (res.ok) {
      const body = (await res.json()) as { apiUrl?: unknown };
      if (typeof body.apiUrl === "string" && body.apiUrl) return body.apiUrl;
    }
  } catch {
    // fall through to build-time configuration
  }
  return import.meta.env.VITE_API_URL || "http://localhost:4000";
}
