/**
 * ETL: load the real datasets shipped under data/raw (+ benchmark results in
 * artifacts/) into PostgreSQL for analytics and the knowledge-base engine.
 *
 * Idempotent: each dataset is fingerprinted (sha256 of its source files) in
 * etl_runs and only reloaded when the source changes or `force` is set.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { asyncBufferFromFile, parquetReadObjects } from "hyparquet";
import type { Db, Queryable } from "../db/index.js";

interface Dataset {
  name: string;
  files: () => string[];
  load: (q: Queryable, files: string[]) => Promise<number>;
}

export interface EtlReport {
  dataset: string;
  status: "loaded" | "unchanged" | "missing";
  rows: number;
}

const fingerprint = (files: string[]) => {
  const h = createHash("sha256");
  for (const f of [...files].sort()) h.update(path.basename(f)).update(readFileSync(f));
  return h.digest("hex");
};

const readParquet = async (file: string) =>
  (await parquetReadObjects({ file: await asyncBufferFromFile(file) })) as Record<string, any>[];

const toNum = (v: unknown) => (typeof v === "bigint" ? Number(v) : v == null || v === "" ? null : Number(v));
const toBool = (v: unknown) => v === true || v === 1 || v === "1" || String(v).toLowerCase() === "true";

/** "06/19/2025" → "2025-06-19" */
const usDate = (s: unknown) => {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(s ?? ""));
  return m ? `${m[3]}-${m[1]}-${m[2]}` : null;
};

/** Bulk insert via jsonb_to_recordset — one round trip per chunk, works on pg and PGlite. */
async function bulkInsert(q: Queryable, table: string, columns: Record<string, string>, rows: object[]) {
  const cols = Object.keys(columns);
  const def = cols.map((c) => `${c} ${columns[c]}`).join(", ");
  for (let i = 0; i < rows.length; i += 2000) {
    await q.query(
      `INSERT INTO ${table} (${cols.join(", ")})
       SELECT ${cols.join(", ")} FROM jsonb_to_recordset($1::jsonb) AS t(${def})
       ON CONFLICT DO NOTHING`,
      [JSON.stringify(rows.slice(i, i + 2000))],
    );
  }
}

export function datasets(root: string): Dataset[] {
  const raw = path.join(root, "data", "raw");
  const listDir = (dir: string, ext: string) =>
    existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(ext)).map((f) => path.join(dir, f)) : [];
  const ifExists = (...files: string[]) => (files.every(existsSync) ? files : []);

  return [
    {
      name: "nhtsa_complaints",
      files: () => listDir(path.join(raw, "NHTSA"), ".json"),
      async load(q, files) {
        await q.query("TRUNCATE nhtsa_complaints CASCADE");
        const complaints: object[] = [];
        const components: object[] = [];
        const seen = new Set<number>();
        for (const f of files) {
          const results = (JSON.parse(readFileSync(f, "utf8")).results ?? []) as any[];
          for (const r of results) {
            const odi = Number(r.odiNumber);
            if (!odi || seen.has(odi)) continue;
            seen.add(odi);
            const prod = (r.products ?? []).find((p: any) => p.type === "Vehicle") ?? {};
            const comps = String(r.components ?? "UNKNOWN OR OTHER")
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean);
            complaints.push({
              odi_number: odi,
              make: String(prod.productMake ?? "").toUpperCase(),
              model: String(prod.productModel ?? "").toUpperCase(),
              model_year: Number(prod.productYear) || 0,
              manufacturer: r.manufacturer ?? null,
              components: comps.join(","),
              crash: Boolean(r.crash),
              fire: Boolean(r.fire),
              injuries: Number(r.numberOfInjuries) || 0,
              deaths: Number(r.numberOfDeaths) || 0,
              incident_date: usDate(r.dateOfIncident),
              filed_date: usDate(r.dateComplaintFiled),
              vin_prefix: r.vin ?? null,
              summary: r.summary ?? null,
            });
            for (const c of new Set(comps)) components.push({ odi_number: odi, component: c });
          }
        }
        await bulkInsert(
          q,
          "nhtsa_complaints",
          {
            odi_number: "bigint", make: "text", model: "text", model_year: "int", manufacturer: "text",
            components: "text", crash: "bool", fire: "bool", injuries: "int", deaths: "int",
            incident_date: "date", filed_date: "date", vin_prefix: "text", summary: "text",
          },
          complaints,
        );
        await bulkInsert(q, "nhtsa_complaint_components", { odi_number: "bigint", component: "text" }, components);
        return complaints.length;
      },
    },
    {
      name: "mechanicdb",
      files: () =>
        ifExists(
          ...["dtc_codes", "diagnostic_fixes", "replacement_parts"].map((f) =>
            path.join(raw, "MechanicDB", `${f}.parquet`),
          ),
        ),
      async load(q, [codesF, fixesF, partsF]) {
        await q.query("TRUNCATE dtc_codes CASCADE");
        const codes = (await readParquet(codesF!)).map((r) => ({
          code_id: toNum(r.code_id),
          dtc_code: String(r.dtc_code).toUpperCase(),
          system_category: r.system_category ?? null,
          is_oem_specific: toBool(r.is_oem_specific),
          oem_make: r.oem_make || null,
          fault_family: r.fault_family ?? null,
          short_description: r.short_description ?? null,
          explanation: r.detailed_technical_explanation ?? null,
        }));
        const fixes = (await readParquet(fixesF!)).map((r) => ({
          fix_id: toNum(r.fix_id),
          code_id: toNum(r.code_id),
          fix_title: r.fix_title,
          probability_rank: toNum(r.probability_rank),
          difficulty_level: r.difficulty_level ?? null,
          parts_cost_min_usd: toNum(r.est_parts_cost_min_usd),
          parts_cost_max_usd: toNum(r.est_parts_cost_max_usd),
          labor_hours: toNum(r.est_labor_hours),
          steps: r.step_by_step_instructions ?? null,
        }));
        const parts = (await readParquet(partsF!)).map((r) => ({
          part_id: toNum(r.part_id),
          fix_id: toNum(r.fix_id),
          part_name: r.part_name,
          search_url: r.amazon_search_query ?? null,
        }));
        await bulkInsert(q, "dtc_codes", {
          code_id: "int", dtc_code: "text", system_category: "text", is_oem_specific: "bool", oem_make: "text",
          fault_family: "text", short_description: "text", explanation: "text",
        }, codes);
        await bulkInsert(q, "dtc_fixes", {
          fix_id: "int", code_id: "int", fix_title: "text", probability_rank: "int", difficulty_level: "text",
          parts_cost_min_usd: "float8", parts_cost_max_usd: "float8", labor_hours: "float8", steps: "text",
        }, fixes);
        await bulkInsert(q, "dtc_parts", { part_id: "int", fix_id: "int", part_name: "text", search_url: "text" }, parts);
        return codes.length + fixes.length + parts.length;
      },
    },
    {
      name: "dtc_finetune",
      files: () => ifExists(path.join(raw, "DTC_FT", "train.parquet"), path.join(raw, "DTC_FT", "validation.parquet")),
      async load(q, files) {
        await q.query("TRUNCATE dtc_ft_examples");
        const rows: object[] = [];
        for (const f of files) {
          const split = path.basename(f, ".parquet");
          for (const r of await readParquet(f)) {
            rows.push({
              split,
              dtc_code: r.dtc_code ? String(r.dtc_code).toUpperCase() : null,
              dtc_system: r.dtc_system ?? null,
              severity: r.severity ?? null,
              category: r.category ?? null,
              vehicle: r.vehicle ?? null,
              is_safety_critical: toBool(r.is_safety_critical),
            });
          }
        }
        await bulkInsert(q, "dtc_ft_examples", {
          split: "text", dtc_code: "text", dtc_system: "text", severity: "text", category: "text",
          vehicle: "text", is_safety_critical: "bool",
        }, rows);
        return rows.length;
      },
    },
    {
      name: "ai4i_2020",
      files: () => ifExists(path.join(raw, "AI4I", "ai4i2020.csv")),
      async load(q, [file]) {
        await q.query("TRUNCATE ai4i_readings");
        const lines = readFileSync(file!, "utf8").replace(/^﻿/, "").split(/\r?\n/).filter(Boolean);
        const rows = lines.slice(1).map((line) => {
          const c = line.split(",");
          return {
            udi: Number(c[0]), product_id: c[1], quality_type: c[2],
            air_temp_k: Number(c[3]), process_temp_k: Number(c[4]), rotational_rpm: Number(c[5]),
            torque_nm: Number(c[6]), tool_wear_min: Number(c[7]), machine_failure: c[8] === "1",
            twf: c[9] === "1", hdf: c[10] === "1", pwf: c[11] === "1", osf: c[12] === "1", rnf: c[13] === "1",
          };
        });
        await bulkInsert(q, "ai4i_readings", {
          udi: "int", product_id: "text", quality_type: "text", air_temp_k: "float8", process_temp_k: "float8",
          rotational_rpm: "int", torque_nm: "float8", tool_wear_min: "int", machine_failure: "bool",
          twf: "bool", hdf: "bool", pwf: "bool", osf: "bool", rnf: "bool",
        }, rows);
        return rows.length;
      },
    },
    {
      name: "model_benchmarks",
      files: () => ifExists(path.join(root, "artifacts", "paper_results.json")),
      async load(q, [file]) {
        await q.query("TRUNCATE model_benchmarks");
        const rows: object[] = [];
        const walk = (o: any, p: string[]) => {
          if (!o || typeof o !== "object" || Array.isArray(o)) return;
          if ("fault_code_accuracy" in o) {
            const parent = p[p.length - 2] ?? "";
            const bySource = parent.endsWith("_by_source");
            rows.push({
              benchmark: bySource ? `${p[0]}:${p[p.length - 1]}` : p.slice(0, -1).join("/"),
              model: bySource ? parent.replace(/_by_source$/, "_mlx") : p[p.length - 1],
              n: o.n ?? null,
              fault_code_accuracy: o.fault_code_accuracy ?? null,
              json_validity_rate: o.json_validity_rate ?? null,
              schema_completeness_rate: o.schema_completeness_rate ?? null,
              severity_accuracy: o.severity_accuracy ?? null,
              rouge_l_repair_steps: o.rouge_l_repair_steps ?? null,
              errors: o.errors ?? null,
            });
            return;
          }
          for (const [k, v] of Object.entries(o)) walk(v, [...p, k]);
        };
        walk(JSON.parse(readFileSync(file!, "utf8")), []);
        await bulkInsert(q, "model_benchmarks", {
          benchmark: "text", model: "text", n: "int", fault_code_accuracy: "float8", json_validity_rate: "float8",
          schema_completeness_rate: "float8", severity_accuracy: "float8", rouge_l_repair_steps: "float8", errors: "int",
        }, rows);
        return rows.length;
      },
    },
  ];
}

export async function runEtl(db: Db, root: string, opts: { force?: boolean; log?: (m: string) => void } = {}) {
  const log = opts.log ?? (() => {});
  const report: EtlReport[] = [];
  const { rows: done } = await db.query<{ dataset: string; source_sha256: string }>(
    "SELECT dataset, source_sha256 FROM etl_runs",
  );
  const prev = new Map(done.map((r) => [r.dataset, r.source_sha256]));

  for (const ds of datasets(root)) {
    const files = ds.files();
    if (!files.length) {
      report.push({ dataset: ds.name, status: "missing", rows: 0 });
      log(`[etl] ${ds.name}: source files missing — skipped`);
      continue;
    }
    const sha = fingerprint(files);
    if (!opts.force && prev.get(ds.name) === sha) {
      report.push({ dataset: ds.name, status: "unchanged", rows: 0 });
      continue;
    }
    const t0 = Date.now();
    const rows = await db.tx(async (q) => {
      const n = await ds.load(q, files);
      await q.query(
        `INSERT INTO etl_runs (dataset, source_path, source_sha256, row_count, loaded_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (dataset) DO UPDATE SET source_path=EXCLUDED.source_path,
           source_sha256=EXCLUDED.source_sha256, row_count=EXCLUDED.row_count, loaded_at=now()`,
        [ds.name, path.relative(root, path.dirname(files[0]!)).replaceAll("\\", "/"), sha, n],
      );
      return n;
    });
    report.push({ dataset: ds.name, status: "loaded", rows });
    log(`[etl] ${ds.name}: ${rows} rows in ${Date.now() - t0} ms`);
  }
  return report;
}
