import { existsSync, readdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

/**
 * Location of one exported pipeline snapshot (`data/exports/<runId>/`). The layout is identical on
 * local disk and on IPFS: tables/*.parquet, geo/*.parquet, run.json, coverage.json, schema.json, tables.json.
 */
export type SnapshotLocation = {
  kind: "local" | "http";
  /** Normalized root without trailing slash. */
  root: string;
  /** Run id inferred from the directory name (overridden by run.json when present). */
  dirRunId: string | null;
};

export function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function looksLikeSnapshot(dir: string): boolean {
  return (
    existsSync(path.join(dir, "tables")) && existsSync(path.join(dir, "tables", "property_leads.parquet"))
  );
}

/**
 * Resolve CRM_DATA_BASE_URL. Relative local paths resolve against the repository root. If a local
 * path points at an `exports/` directory rather than a single run, the lexicographically latest run
 * directory containing a snapshot is used (pipeline run ids sort chronologically).
 */
export function resolveSnapshotLocation(baseUrl: string, repoRoot: string): SnapshotLocation {
  if (isHttpUrl(baseUrl)) {
    const root = baseUrl.replace(/\/+$/, "");
    return { kind: "http", root, dirRunId: null };
  }
  const abs = path.resolve(repoRoot, baseUrl);
  if (!existsSync(abs)) {
    throw new Error(`CRM_DATA_BASE_URL does not exist: ${abs}`);
  }
  if (looksLikeSnapshot(abs)) return { kind: "local", root: abs, dirRunId: path.basename(abs) };
  const runs = readdirSync(abs)
    .filter((name) => statSync(path.join(abs, name)).isDirectory() && looksLikeSnapshot(path.join(abs, name)))
    .sort();
  const latest = runs.at(-1);
  if (!latest) throw new Error(`No snapshot (tables/property_leads.parquet) found under ${abs}`);
  return { kind: "local", root: path.join(abs, latest), dirRunId: latest };
}

export function fileUrl(loc: SnapshotLocation, rel: string): string {
  return loc.kind === "http" ? `${loc.root}/${rel}` : path.join(loc.root, rel);
}

export async function readSnapshotJson(
  loc: SnapshotLocation,
  rel: string,
  timeoutMs = 15_000,
): Promise<unknown> {
  if (loc.kind === "local") {
    const p = path.join(loc.root, rel);
    if (!existsSync(p)) return null;
    return JSON.parse(await readFile(p, "utf8")) as unknown;
  }
  const res = await fetch(`${loc.root}/${rel}`, { signal: AbortSignal.timeout(timeoutMs) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Fetching ${rel} failed: HTTP ${res.status}`);
  return (await res.json()) as unknown;
}

export const schemaJsonSchema = z.record(
  z.string(),
  z.object({
    description: z.string().optional(),
    columns: z.array(z.object({ name: z.string(), type: z.string() })),
  }),
);
export type SnapshotSchema = z.infer<typeof schemaJsonSchema>;

export const tablesJsonSchema = z.array(
  z.object({ name: z.string(), file: z.string(), rows: z.number(), description: z.string().optional() }),
);
export type SnapshotTables = z.infer<typeof tablesJsonSchema>;

export const runJsonSchema = z
  .object({
    asOf: z.string().optional(),
    run: z.object({ run_id: z.string().optional() }).passthrough().nullable().optional(),
    sources: z
      .array(
        z
          .object({
            source_id: z.string().optional(),
            status: z.string().optional(),
            limitation: z.string().nullable().optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();
export type RunJson = z.infer<typeof runJsonSchema>;
