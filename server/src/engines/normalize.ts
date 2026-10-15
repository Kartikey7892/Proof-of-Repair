/**
 * Report normalization shared by every engine (port of src/llm/infer.py):
 * coerce types, clamp values, collapse small-LLM token loops, and fill
 * deterministic workshop defaults when steps/parts are missing.
 */
import type { RepairReport } from "../por/proof.js";

export function collapseRunawayText(text: unknown, maxLen = 400): string {
  let s = String(text ?? "").trim();
  if (!s) return s;
  let prev: string | null = null;
  while (prev !== s) {
    prev = s;
    s = s.replace(/(\b[\w.+#-]{1,32}\b)(?:\s*[|/]\s*\1){2,}/gi, "$1");
    s = s.replace(/(\b[\w.+#-]{2,32}\b)(?:\s+\1){3,}/gi, "$1");
  }
  s = s.replace(/\s{2,}/g, " ").replace(/^[ /|-]+|[ /|-]+$/g, "");
  if (s.length > maxLen) s = s.slice(0, maxLen - 1).trimEnd() + "…";
  return s;
}

export function isRunawayText(text: unknown): boolean {
  const s = String(text ?? "");
  if (s.length > 500 && new Set(s.split(/\s+/)).size < 12) return true;
  return /(\b[\w.+#-]{1,32}\b)(?:\s*[|/]\s*\1){4,}/i.test(s);
}

export interface WorkshopDefaults {
  diagnosis: string;
  parts: string[];
  repair_steps: string[];
  qa_checks: string[];
  estimated_minutes: number;
}

export function workshopDefaults(faultCode: string, symptoms = ""): WorkshopDefaults {
  const fc = (faultCode || "UNKNOWN").toUpperCase().trim();
  const sym = symptoms.toLowerCase();
  if (fc.startsWith("P042") || sym.includes("catalytic") || sym.includes("emissions")) {
    return {
      diagnosis: `${fc}: catalyst efficiency below threshold — exhaust leak, O2 sensor, or converter.`,
      parts: ["Downstream O2 sensor", "Catalytic converter (if confirmed)"],
      repair_steps: [
        "Confirm P0420 with freeze-frame and bidirectional O2 data",
        "Smoke/inspect exhaust for pre-cat leaks",
        "Compare upstream vs downstream O2 switching",
        "Replace failed sensor or converter; clear codes; verify monitors",
      ],
      qa_checks: ["No P0420 after drive cycle", "Catalyst monitor ready/pass"],
      estimated_minutes: 120,
    };
  }
  if (fc.startsWith("P030") || sym.includes("misfire")) {
    return {
      diagnosis: `${fc}: cylinder misfire — ignition, injector, compression, or vacuum leak.`,
      parts: ["Spark plugs", "Ignition coil(s)"],
      repair_steps: [
        "Pull misfire counts and freeze-frame",
        "Swap coil/plug to confirm cylinder follow",
        "Check fuel trims and injector contribution",
        "Repair root cause; clear codes; road-test under load",
      ],
      qa_checks: ["Misfire counts remain zero", "No CEL after mixed drive"],
      estimated_minutes: 90,
    };
  }
  if (fc.startsWith("C") || sym.includes("abs") || sym.includes("wheel speed")) {
    return {
      diagnosis: `${fc}: ABS wheel-speed circuit fault — sensor, tone ring, or wiring.`,
      parts: ["Wheel speed sensor", "Sensor pigtail / connector"],
      repair_steps: [
        "Scan ABS module and note which corner failed",
        "Inspect harness for chafe at knuckle/strut",
        "Measure sensor resistance and signal while spinning hub",
        "Replace sensor if out of range; clear ABS codes; road-test",
      ],
      qa_checks: ["ABS light off", "All wheel-speed PIDs agree in a straight line"],
      estimated_minutes: 75,
    };
  }
  return {
    diagnosis: `${fc}: workshop inspection required for used-vehicle attestation.`,
    parts: ["Diagnostic time / scan tool"],
    repair_steps: [
      "Confirm DTC with OEM-level scan",
      "Inspect related connectors and grounds",
      "Repair verified fault; clear codes; document post-repair screenshot",
    ],
    qa_checks: ["DTC does not return", "Buyer receives invoice + OBD screenshot"],
    estimated_minutes: 60,
  };
}

const toList = (val: unknown): string[] => {
  const arr = typeof val === "string" ? [val] : Array.isArray(val) ? val : [];
  return arr
    .map((x) => collapseRunawayText(x, 220))
    .filter((x) => x && !isRunawayText(x))
    .slice(0, 12);
};

const num = (v: unknown, d: number) => {
  const n = Number.parseFloat(String(v));
  return Number.isFinite(n) ? n : d;
};

export function normalizeReport(
  data: Record<string, unknown>,
  fallbackDtc = "",
  symptoms = "",
): RepairReport {
  let severity = String(data.severity ?? "medium").toLowerCase();
  if (severity === "critical") severity = "high";
  if (!["low", "medium", "high"].includes(severity)) severity = "medium";

  const fault_code = String(data.fault_code ?? (fallbackDtc || "UNKNOWN")).slice(0, 64);
  const out: RepairReport = {
    fault_code,
    diagnosis: collapseRunawayText(String(data.diagnosis ?? "See workshop inspection notes.").replace(/\*+/g, ""), 400),
    severity,
    parts: toList(data.parts),
    repair_steps: toList(data.repair_steps),
    qa_checks: toList(data.qa_checks),
    estimated_minutes: Math.trunc(num(data.estimated_minutes, 60)),
    confidence: Math.max(0, Math.min(1, num(data.confidence, 0.7))),
    buyer_advice: collapseRunawayText(
      data.buyer_advice ?? "Request repair invoice and post-repair OBD screenshot before purchase.",
      400,
    ),
  };

  const d = workshopDefaults(fault_code, symptoms);
  if (isRunawayText(out.diagnosis) || out.diagnosis.length < 12) {
    out.diagnosis = d.diagnosis;
    out.confidence = Math.min(out.confidence, 0.55);
  }
  if (!out.repair_steps.length) out.repair_steps = [...d.repair_steps];
  if (!out.parts.length) out.parts = [...d.parts];
  if (!out.qa_checks.length) out.qa_checks = [...d.qa_checks];
  return out;
}

/** Extract OBD-II codes (P/C/B/U + 4 hex digits) in order of appearance. */
export function extractDtcCodes(...texts: string[]): string[] {
  const seen = new Set<string>();
  for (const t of texts) for (const m of t.toUpperCase().matchAll(/\b[PCBU][0-9A-F]{4}\b/g)) seen.add(m[0]);
  return [...seen];
}
