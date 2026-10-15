import type { Db } from "../db/index.js";
import { KnowledgeBaseEngine } from "./kb.js";
import { InferenceSidecar, RemoteLoraEngine } from "./remote.js";
import { EngineUnavailableError, type DiagnosisEngine } from "./types.js";

export * from "./types.js";

export class EngineRegistry {
  readonly kb: KnowledgeBaseEngine;
  private engines: Map<string, DiagnosisEngine>;

  constructor(db: Db, root: string, inferenceUrl: string) {
    const sidecar = new InferenceSidecar(inferenceUrl);
    this.kb = new KnowledgeBaseEngine(db, root);
    this.engines = new Map<string, DiagnosisEngine>([
      ["kb", this.kb],
      ["tinyllama", new RemoteLoraEngine("tinyllama", sidecar)],
      ["mistral", new RemoteLoraEngine("mistral", sidecar)],
    ]);
  }

  async availability(): Promise<Record<string, boolean>> {
    const entries = await Promise.all(
      [...this.engines].map(async ([name, e]) => [name, await e.available().catch(() => false)] as const),
    );
    return Object.fromEntries(entries);
  }

  /** `auto` prefers the most accurate engine that is up: mistral → tinyllama → kb. */
  async resolve(requested: string): Promise<DiagnosisEngine> {
    const name = (requested || "auto").toLowerCase().trim();
    if (name === "auto") {
      for (const n of ["mistral", "tinyllama", "kb"]) {
        const e = this.engines.get(n)!;
        if (await e.available().catch(() => false)) return e;
      }
      throw new EngineUnavailableError("no diagnosis engine available — run `npm run etl` to build the knowledge base");
    }
    const engine = this.engines.get(name);
    if (!engine) throw new EngineUnavailableError(`unknown engine '${requested}' (use kb, tinyllama, mistral or auto)`);
    return engine;
  }
}
