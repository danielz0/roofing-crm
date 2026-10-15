import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { leadSchema } from "@roofing-crm/shared";
import { z } from "zod";
import { InMemoryLeadRepository } from "./memory.js";
import type { LeadRepository } from "./repository.js";

/** JSON-file-backed repository for local development (atomic write via rename). */
export class FileLeadRepository extends InMemoryLeadRepository {
  override readonly kind: LeadRepository["kind"] = "file";
  private writeChain: Promise<void> = Promise.resolve();

  private constructor(private readonly file: string) {
    super();
  }

  static async open(file: string): Promise<FileLeadRepository> {
    const repo = new FileLeadRepository(file);
    if (existsSync(file)) {
      const parsed = z.array(leadSchema).parse(JSON.parse(await readFile(file, "utf8")));
      for (const lead of parsed) repo.leads.set(lead.id, lead);
    }
    return repo;
  }

  protected override async persist(): Promise<void> {
    const snapshot = JSON.stringify([...this.leads.values()], null, 2);
    this.writeChain = this.writeChain.then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await writeFile(tmp, snapshot);
      await rename(tmp, this.file);
    });
    await this.writeChain;
  }
}
