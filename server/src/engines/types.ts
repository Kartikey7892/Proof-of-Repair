import type { ModelProvenance, RepairReport } from "../por/proof.js";

export interface DiagnoseInput {
  vehicle: string;
  symptoms: string;
  dtc_codes: string;
  sensor_notes: string;
}

export interface Diagnosis {
  report: RepairReport;
  /** Provenance of the exact model / knowledge snapshot that produced the report. */
  model: ModelProvenance;
}

export interface DiagnosisEngine {
  readonly name: string;
  available(): Promise<boolean>;
  diagnose(input: DiagnoseInput): Promise<Diagnosis>;
}

/** Raised when a requested engine cannot serve; maps to HTTP 400 like the FastAPI version. */
export class EngineUnavailableError extends Error {
  readonly status = 400;
}
