/**
 * Knowledge-base diagnosis engine (runs in Node, no model weights).
 *
 * Retrieval over the real MechanicDB OBD-II repair database (DTC → ranked
 * fixes → parts, labor, cost) with severity priors from the
 * automotive-dtc-finetune labels. Deterministic, so its provenance hash pins
 * the exact knowledge snapshot that produced a sealed report.
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { canonicalDumps } from "../crypto/canonical.js";
import { sha256Hex } from "../crypto/merkle.js";
import type { Db } from "../db/index.js";
import type { ModelProvenance, RepairReport } from "../por/proof.js";
import { parseVehicle } from "../util/vehicle.js";
import { extractDtcCodes, normalizeReport, workshopDefaults } from "./normalize.js";
import type { DiagnoseInput, Diagnosis, DiagnosisEngine } from "./types.js";

interface KbCode {
  code_id: number;
  dtc_code: string;
  system_category: string | null;
  is_oem_specific: boolean;
  oem_make: string | null;
  fault_family: string | null;
  short_description: string | null;
  explanation: string | null;
}
interface KbFix {
  fix_id: number;
  code_id: number;
  fix_title: string;
  probability_rank: number | null;
  difficulty_level: string | null;
  parts_cost_min_usd: number | null;
  parts_cost_max_usd: number | null;
  labor_hours: number | null;
  steps: string | null;
}

interface Snapshot {
  codes: KbCode[];
  fixesByCode: Map<number, KbFix[]>;
  partsByFix: Map<number, string[]>;
  severityByCode: Map<string, { severity: string; safety: boolean }>;
  tokens: Map<number, Set<string>>;
  hash: string;
}

const STOP = new Set(
  "the a an and or of to in on at for with from is are was were be been it this that when after under over very not no my car vehicle light".split(" "),
);
const tokenize = (s: string) =>
  new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 2 && !STOP.has(t)),
  );

const SEVERITY_MAP: Record<string, string> = { critical: "high", high: "high", medium: "medium", moderate: "medium", low: "low" };

export class KnowledgeBaseEngine implements DiagnosisEngine {
  readonly name = "kb";
  private snap: Snapshot | null = null;
  private datasetRoot = "";

  constructor(
    private db: Db,
    root: string,
  ) {
    const manifest = path.join(root, "artifacts", "dataset_manifest.json");
    if (existsSync(manifest)) {
      try {
        this.datasetRoot = JSON.parse(readFileSync(manifest, "utf8")).dataset_merkle_root ?? "";
      } catch {
        /* optional */
      }
    }
  }

  async available() {
    const { rows } = await this.db.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM dtc_codes");
    return (rows[0]?.n ?? 0) > 0;
  }

  /** Drop the cached snapshot (after an ETL reload). */
  invalidate() {
    this.snap = null;
  }

  private async load(): Promise<Snapshot> {
    if (this.snap) return this.snap;
    const [{ rows: codes }, { rows: fixes }, { rows: parts }, { rows: sev }] = await Promise.all([
      this.db.query<KbCode>("SELECT * FROM dtc_codes ORDER BY code_id"),
      this.db.query<KbFix>("SELECT * FROM dtc_fixes ORDER BY code_id, probability_rank NULLS LAST, fix_id"),
      this.db.query<{ fix_id: number; part_name: string }>("SELECT fix_id, part_name FROM dtc_parts ORDER BY part_id"),
      this.db.query<{ dtc_code: string; severity: string; safety: boolean }>(
        `SELECT DISTINCT ON (dtc_code) dtc_code, lower(severity) AS severity, bool_or(is_safety_critical) AS safety
         FROM dtc_ft_examples WHERE dtc_code IS NOT NULL
         GROUP BY dtc_code, lower(severity)
         ORDER BY dtc_code, COUNT(*) DESC, lower(severity)`,
      ),
    ]);
    if (!codes.length) throw new Error("Knowledge base is empty — run `npm run etl` first");

    const fixesByCode = new Map<number, KbFix[]>();
    for (const f of fixes) fixesByCode.set(f.code_id, [...(fixesByCode.get(f.code_id) ?? []), f]);
    const partsByFix = new Map<number, string[]>();
    for (const p of parts) partsByFix.set(p.fix_id, [...(partsByFix.get(p.fix_id) ?? []), p.part_name]);
    const tokens = new Map(
      codes.map((c) => [
        c.code_id,
        tokenize(
          `${c.short_description ?? ""} ${(c.fault_family ?? "").replace(/_/g, " ")} ${(c.explanation ?? "").slice(0, 600)}`,
        ),
      ]),
    );
    const hash = sha256Hex(canonicalDumps({ codes, fixes, parts }));
    this.snap = {
      codes,
      fixesByCode,
      partsByFix,
      severityByCode: new Map(sev.map((s) => [s.dtc_code, { severity: s.severity, safety: s.safety }])),
      tokens,
      hash,
    };
    return this.snap;
  }

  async provenance(): Promise<ModelProvenance> {
    const s = await this.load();
    return {
      model_name: "kb:mechanicdb-obd2+automotive-dtc-finetune",
      model_version: "kb-v1",
      adapter_hash: s.hash,
      dataset_merkle_root: this.datasetRoot,
      framework: "retrieval+rules",
    };
  }

  private pick(s: Snapshot, code: string, make: string | null): { c: KbCode; match: "exact" | "oem_other" | "family" } | null {
    const exact = s.codes.filter((c) => c.dtc_code === code);
    if (exact.length) {
      const oem = exact.find((c) => c.oem_make && make && c.oem_make.toUpperCase() === make);
      const generic = exact.find((c) => !c.is_oem_specific);
      if (oem) return { c: oem, match: "exact" };
      if (generic) return { c: generic, match: "exact" };
      return { c: exact[0]!, match: "oem_other" };
    }
    // Same 4-char family (P042x → P0420, P030x → P0300 …), generic codes first.
    const fam = s.codes
      .filter((c) => c.dtc_code.slice(0, 4) === code.slice(0, 4))
      .sort((a, b) => Number(a.is_oem_specific) - Number(b.is_oem_specific) || a.dtc_code.localeCompare(b.dtc_code));
    return fam[0] ? { c: fam[0], match: "family" } : null;
  }

  private bySymptoms(s: Snapshot, text: string): { c: KbCode; score: number } | null {
    const q = tokenize(text);
    if (!q.size) return null;
    let best: { c: KbCode; score: number } | null = null;
    for (const c of s.codes) {
      const t = s.tokens.get(c.code_id)!;
      let hit = 0;
      for (const w of q) if (t.has(w)) hit++;
      const score = hit / q.size;
      if (hit >= 2 && (!best || score > best.score)) best = { c, score };
    }
    return best;
  }

  private severityFor(s: Snapshot, c: KbCode): { severity: string; safety: boolean } {
    const prior = s.severityByCode.get(c.dtc_code);
    if (prior) return { severity: SEVERITY_MAP[prior.severity] ?? "medium", safety: prior.safety };
    const fam = `${c.fault_family ?? ""} ${c.short_description ?? ""}`.toLowerCase();
    if (c.system_category === "Chassis" || /brake|abs|airbag|steering/.test(fam)) return { severity: "high", safety: true };
    if (/misfire|overheat|coolant temp|oil pressure|processor|crankshaft|camshaft/.test(fam)) return { severity: "high", safety: false };
    if (/evap|leak detect|purge|gas cap/.test(fam)) return { severity: "low", safety: false };
    return { severity: "medium", safety: false };
  }

  async diagnose(input: DiagnoseInput): Promise<Diagnosis> {
    const report = await this.report(input);
    return { report, model: await this.provenance() };
  }

  private async report(input: DiagnoseInput): Promise<RepairReport> {
    const s = await this.load();
    const make = parseVehicle(input.vehicle).make;
    const codes = extractDtcCodes(input.dtc_codes, input.symptoms, input.sensor_notes);
    const symptomText = `${input.symptoms} ${input.sensor_notes}`;

    let hit: { c: KbCode; match: "exact" | "oem_other" | "family" | "symptoms" } | null = null;
    let symptomScore = 0;
    for (const code of codes) {
      const p = this.pick(s, code, make);
      if (p && (!hit || (hit.match !== "exact" && p.match === "exact"))) hit = p;
      if (hit?.match === "exact") break;
    }
    if (!hit) {
      const bs = this.bySymptoms(s, symptomText);
      if (bs) {
        hit = { c: bs.c, match: "symptoms" };
        symptomScore = bs.score;
      }
    }
    const reportedCode = codes[0] ?? hit?.c.dtc_code ?? "UNKNOWN";

    if (!hit) {
      // Nothing in the KB matches: fall back to deterministic workshop defaults.
      const d = workshopDefaults(reportedCode, symptomText);
      return normalizeReport(
        { ...d, fault_code: reportedCode, severity: "medium", confidence: 0.3 },
        reportedCode,
        symptomText,
      );
    }

    const { c, match } = hit;
    const fixes = s.fixesByCode.get(c.code_id) ?? [];
    const top = fixes[0];
    const steps = (top?.steps ?? "")
      .split(/\s*[•\n]\s*/)
      .map((x) => x.trim())
      .filter(Boolean)
      .slice(0, 6);
    for (const f of fixes.slice(1, 3)) steps.push(`If unresolved: ${f.fix_title}`);

    const parts = [...new Set(fixes.slice(0, 2).flatMap((f) => s.partsByFix.get(f.fix_id) ?? []))].slice(0, 6);
    const { severity, safety } = this.severityFor(s, c);
    const faultCode = match === "family" || match === "symptoms" ? (codes[0] ?? c.dtc_code) : c.dtc_code;

    const firstSentence = (c.explanation ?? "").split(/(?<=\.)\s/)[0] ?? "";
    const diagnosis = [
      `${faultCode}: ${c.short_description ?? c.fault_family ?? "fault"}.`,
      match === "family" ? `Closest catalogued code ${c.dtc_code}.` : "",
      top ? `Most likely fix: ${top.fix_title}.` : "",
      firstSentence,
    ]
      .filter(Boolean)
      .join(" ");

    const costMin = top?.parts_cost_min_usd ?? null;
    const costMax = top?.parts_cost_max_usd ?? null;
    const labor = top?.labor_hours ?? null;
    const costNote =
      costMin != null && costMax != null
        ? ` Typical first fix: $${Math.round(costMin)}–$${Math.round(costMax)} parts${labor != null ? ` + ${labor} h labor` : ""}.`
        : "";
    const buyer_advice =
      severity === "high"
        ? `${safety ? "Safety-relevant fault. " : ""}Do not complete the purchase until a repair invoice and a post-repair OBD scan show ${faultCode} cleared.${costNote}`
        : severity === "low"
          ? `Minor fault; ask for the invoice and a readiness-monitor screenshot, or negotiate the repair cost.${costNote}`
          : `Ask for the repair invoice${parts.length ? ` (${parts.slice(0, 2).join(", ")})` : ""} and a post-repair OBD scan; negotiate if unrepaired.${costNote}`;

    const confidence =
      match === "exact"
        ? 0.85
        : match === "oem_other"
          ? 0.72
          : match === "family"
            ? 0.55
            : Math.min(0.5, 0.25 + symptomScore);

    return normalizeReport(
      {
        fault_code: faultCode,
        diagnosis,
        severity,
        parts,
        repair_steps: steps,
        qa_checks: [
          `${faultCode} does not return after a complete drive cycle`,
          "All OBD readiness monitors report complete",
          ...workshopDefaults(faultCode, symptomText).qa_checks.slice(0, 1),
        ],
        estimated_minutes: labor != null ? Math.max(15, Math.round(labor * 60) + 15) : 60,
        confidence,
        buyer_advice,
      },
      reportedCode,
      symptomText,
    );
  }
}
