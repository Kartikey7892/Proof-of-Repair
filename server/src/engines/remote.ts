/**
 * Fine-tuned LoRA engines (TinyLlama PEFT, Mistral MLX) served by the Python
 * inference sidecar `ml/inference_server.py`. PyTorch / MLX can't run inside
 * Node, so Express calls the sidecar over HTTP and re-normalizes its output.
 */
import type { ModelProvenance } from "../por/proof.js";
import { normalizeReport } from "./normalize.js";
import { EngineUnavailableError, type DiagnoseInput, type Diagnosis, type DiagnosisEngine } from "./types.js";

interface SidecarHealth {
  engines: Record<string, boolean>;
}

/** Shared, briefly cached view of what the sidecar can serve. */
export class InferenceSidecar {
  private cache: { at: number; health: SidecarHealth | null } = { at: 0, health: null };
  constructor(readonly baseUrl: string) {}

  async health(): Promise<SidecarHealth | null> {
    if (Date.now() - this.cache.at < 10_000) return this.cache.health;
    let health: SidecarHealth | null = null;
    try {
      const res = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) health = (await res.json()) as SidecarHealth;
    } catch {
      health = null;
    }
    this.cache = { at: Date.now(), health };
    return health;
  }

  async diagnose(engine: string, input: DiagnoseInput): Promise<{ report: Record<string, unknown>; model: ModelProvenance }> {
    const res = await fetch(`${this.baseUrl}/diagnose`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ engine, ...input }),
      // First call loads the model; Mistral on CPU can take minutes.
      signal: AbortSignal.timeout(15 * 60_000),
    });
    const body = (await res.json().catch(() => ({}))) as any;
    if (!res.ok) throw new EngineUnavailableError(body.detail ?? `inference sidecar error ${res.status}`);
    return body;
  }
}

export class RemoteLoraEngine implements DiagnosisEngine {
  constructor(
    readonly name: "tinyllama" | "mistral",
    private sidecar: InferenceSidecar,
  ) {}

  async available() {
    return Boolean((await this.sidecar.health())?.engines?.[this.name]);
  }

  async diagnose(input: DiagnoseInput): Promise<Diagnosis> {
    if (!(await this.available())) {
      throw new EngineUnavailableError(
        `${this.name} adapter not available — start the inference sidecar (python ml/inference_server.py) with trained adapters in artifacts/adapters/`,
      );
    }
    const out = await this.sidecar.diagnose(this.name, input);
    const fallbackDtc = input.dtc_codes.split(",")[0]?.trim() ?? "";
    return {
      report: normalizeReport(out.report, fallbackDtc, input.symptoms),
      model: {
        model_name: out.model.model_name,
        model_version: out.model.model_version,
        adapter_hash: out.model.adapter_hash ?? "",
        dataset_merkle_root: out.model.dataset_merkle_root ?? "",
        framework: out.model.framework ?? "transformers+peft",
      },
    };
  }
}
