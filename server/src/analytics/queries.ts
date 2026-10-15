/**
 * Analytics over the registry (operational data) and the loaded datasets.
 * All aggregation happens in PostgreSQL (CTEs, FILTER, window functions,
 * percentile_cont, generate_series) — Node only shapes the JSON.
 */
import type { Db } from "../db/index.js";
import { parseVehicle } from "../util/vehicle.js";

const round = (n: number | null | undefined, d = 3) => (n == null ? null : Math.round(n * 10 ** d) / 10 ** d);

export class Analytics {
  constructor(private db: Db) {}

  private async one<T = any>(sql: string, params: unknown[] = []): Promise<T> {
    return (await this.db.query<T>(sql, params)).rows[0]!;
  }
  private async all<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
    return (await this.db.query<T>(sql, params)).rows;
  }

  /** Operational KPIs of the repair registry. */
  async overview(days = 30) {
    const totals = await this.one(
      `WITH first_anchor AS (
         SELECT pa.proof_id, MIN(a.created_at) AS anchored_at
         FROM proof_anchors pa JOIN anchors a ON a.batch_id = pa.batch_id
         GROUP BY pa.proof_id)
       SELECT COUNT(*)::int                                         AS proofs,
              COUNT(DISTINCT p.vin)::int                             AS vins,
              COUNT(fa.proof_id)::int                                AS anchored_proofs,
              (COUNT(*) - COUNT(fa.proof_id))::int                   AS pending_proofs,
              (SELECT COUNT(*)::int FROM anchors)                    AS batches,
              AVG(p.confidence)                                      AS avg_confidence,
              AVG(p.odometer_km)                                     AS avg_odometer_km,
              percentile_cont(0.5) WITHIN GROUP (
                ORDER BY EXTRACT(EPOCH FROM fa.anchored_at - p.sealed_at)) AS median_seconds_to_anchor,
              COUNT(*) FILTER (WHERE p.severity = 'high')::int       AS high_severity
       FROM proofs p LEFT JOIN first_anchor fa ON fa.proof_id = p.proof_id`,
    );

    const [perDay, severity, engines, eventTypes, topCodes, byMake, odometer, lookups] = await Promise.all([
      this.all(
        `WITH days AS (
           SELECT generate_series(date_trunc('day', now()) - ($1::int - 1) * interval '1 day',
                                  date_trunc('day', now()), interval '1 day') AS day)
         SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
                COUNT(p.proof_id)::int AS sealed,
                COUNT(p.proof_id) FILTER (WHERE p.severity = 'high')::int AS high_severity
         FROM days d LEFT JOIN proofs p ON date_trunc('day', p.sealed_at) = d.day
         GROUP BY d.day ORDER BY d.day`,
        [days],
      ),
      this.all(`SELECT COALESCE(severity, 'unknown') AS severity, COUNT(*)::int AS n FROM proofs GROUP BY 1 ORDER BY 2 DESC`),
      this.all(
        `SELECT COALESCE(engine, 'unknown') AS engine, COUNT(*)::int AS n,
                AVG(confidence) AS avg_confidence,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY diagnosis_ms) AS median_ms
         FROM proofs GROUP BY 1 ORDER BY 2 DESC`,
      ),
      this.all(`SELECT event_type, COUNT(*)::int AS n FROM proofs GROUP BY 1 ORDER BY 2 DESC`),
      this.all(
        `SELECT p.fault_code, COUNT(*)::int AS n, COUNT(DISTINCT p.vin)::int AS vins,
                MAX(d.short_description) AS description
         FROM proofs p LEFT JOIN dtc_codes d ON d.dtc_code = p.fault_code
         GROUP BY p.fault_code ORDER BY n DESC, p.fault_code LIMIT 10`,
      ),
      this.all(
        `SELECT COALESCE(vehicle_make, 'UNKNOWN') AS make, COUNT(*)::int AS n,
                COUNT(DISTINCT vin)::int AS vins, AVG(odometer_km) AS avg_odometer_km
         FROM proofs GROUP BY 1 ORDER BY 2 DESC LIMIT 12`,
      ),
      this.all(
        `SELECT LEAST(width_bucket(odometer_km, 0, 300000, 12), 13) AS bucket, COUNT(*)::int AS n
         FROM proofs WHERE odometer_km IS NOT NULL GROUP BY 1 ORDER BY 1`,
      ),
      this.one(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE looked_up_at > now() - interval '7 days')::int AS last_7_days,
                COUNT(*) FILTER (WHERE result_count > 0)::int AS with_history,
                COUNT(DISTINCT vin)::int AS distinct_vins
         FROM vin_lookups`,
      ),
    ]);

    return {
      totals: {
        ...totals,
        anchor_rate: totals.proofs ? round(totals.anchored_proofs / totals.proofs) : null,
        avg_confidence: round(totals.avg_confidence),
        avg_odometer_km: totals.avg_odometer_km == null ? null : Math.round(totals.avg_odometer_km),
        median_seconds_to_anchor: round(totals.median_seconds_to_anchor, 1),
      },
      proofs_per_day: perDay,
      severity_mix: severity,
      engines: engines.map((e) => ({ ...e, avg_confidence: round(e.avg_confidence), median_ms: round(e.median_ms, 0) })),
      event_types: eventTypes,
      top_fault_codes: topCodes,
      by_make: byMake.map((m) => ({ ...m, avg_odometer_km: Math.round(m.avg_odometer_km ?? 0) })),
      odometer_buckets: odometer.map((b) => ({
        from_km: (b.bucket - 1) * 25000,
        to_km: b.bucket > 12 ? null : b.bucket * 25000,
        n: b.n,
      })),
      buyer_lookups: {
        ...lookups,
        hit_rate: lookups.total ? round(lookups.with_history / lookups.total) : null,
      },
    };
  }

  /** NHTSA owner-complaint analytics, optionally filtered to one vehicle. */
  async complaints(f: { make?: string; model?: string; year?: number }) {
    const where: string[] = [];
    const params: unknown[] = [];
    if (f.make) where.push(`c.make = $${params.push(f.make.toUpperCase())}`);
    if (f.model) where.push(`c.model = $${params.push(f.model.toUpperCase())}`);
    if (f.year) where.push(`c.model_year = $${params.push(f.year)}`);
    const w = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const [totals, byComponent, byVehicle, byYear, heat] = await Promise.all([
      this.one(
        `SELECT COUNT(*)::int AS complaints,
                COUNT(*) FILTER (WHERE crash)::int AS crashes,
                COUNT(*) FILTER (WHERE fire)::int AS fires,
                COALESCE(SUM(injuries), 0)::int AS injuries,
                COALESCE(SUM(deaths), 0)::int AS deaths,
                MIN(filed_date) AS first_filed, MAX(filed_date) AS last_filed
         FROM nhtsa_complaints c ${w}`,
        params,
      ),
      this.all(
        `SELECT cc.component, COUNT(*)::int AS n,
                ROUND(100.0 * COUNT(*) / SUM(COUNT(*)) OVER (), 1)::float AS share_pct,
                COUNT(*) FILTER (WHERE c.crash)::int AS crashes
         FROM nhtsa_complaints c JOIN nhtsa_complaint_components cc USING (odi_number) ${w}
         GROUP BY cc.component ORDER BY n DESC LIMIT 15`,
        params,
      ),
      this.all(
        `SELECT make, model, model_year, COUNT(*)::int AS complaints,
                ROUND(100.0 * COUNT(*) FILTER (WHERE crash) / COUNT(*), 2)::float AS crash_rate_pct,
                COUNT(*) FILTER (WHERE fire)::int AS fires
         FROM nhtsa_complaints c ${w}
         GROUP BY make, model, model_year ORDER BY complaints DESC`,
        params,
      ),
      this.all(
        `SELECT EXTRACT(YEAR FROM incident_date)::int AS year, COUNT(*)::int AS n
         FROM nhtsa_complaints c ${w ? `${w} AND` : "WHERE"} incident_date IS NOT NULL
         GROUP BY 1 ORDER BY 1`,
        params,
      ),
      // Component share per vehicle (rows) for the top components overall → heatmap.
      this.all(
        `WITH top AS (
           SELECT component FROM nhtsa_complaint_components
           WHERE component <> 'UNKNOWN OR OTHER'
           GROUP BY component ORDER BY COUNT(*) DESC LIMIT 8),
         per AS (
           SELECT c.make || ' ' || c.model || ' ' || c.model_year AS vehicle, cc.component, COUNT(*) AS n,
                  SUM(COUNT(*)) OVER (PARTITION BY c.make, c.model, c.model_year) AS total
           FROM nhtsa_complaints c JOIN nhtsa_complaint_components cc USING (odi_number) ${w}
           GROUP BY c.make, c.model, c.model_year, cc.component)
         SELECT per.vehicle, per.component, per.n::int,
                ROUND(100.0 * per.n / per.total, 1)::float AS share_pct
         FROM per JOIN top USING (component) ORDER BY per.vehicle, per.component`,
        params,
      ),
    ]);
    return { filter: f, totals, by_component: byComponent, by_vehicle: byVehicle, by_incident_year: byYear, component_heatmap: heat };
  }

  /**
   * Buyer risk profile for a vehicle: how its complaint mix compares with the
   * fleet (lift > 1 = this model over-indexes on that component), plus what
   * the registry has already sealed for the same make/model.
   */
  async vehicleRisk(vehicle: string) {
    const v = parseVehicle(vehicle);
    if (!v.make || !v.model) return { vehicle, parsed: v, matched: false, components: [], registry: null };

    // NHTSA model names are single tokens ("CIVIC", "F-150"); match on the first word.
    const modelKey = v.model.split(" ")[0]!;
    const components = await this.all(
      `WITH fleet AS (
         SELECT cc.component, COUNT(*)::float / SUM(COUNT(*)) OVER () AS fleet_share
         FROM nhtsa_complaint_components cc GROUP BY cc.component),
       veh AS (
         SELECT cc.component, COUNT(*) AS n, COUNT(*) FILTER (WHERE c.crash) AS crashes,
                COUNT(*)::float / SUM(COUNT(*)) OVER () AS share
         FROM nhtsa_complaints c JOIN nhtsa_complaint_components cc USING (odi_number)
         WHERE c.make = $1 AND c.model = $2 AND ($3::int IS NULL OR c.model_year = $3)
         GROUP BY cc.component)
       SELECT veh.component, veh.n::int, veh.crashes::int,
              ROUND((100 * veh.share)::numeric, 1)::float AS share_pct,
              ROUND((veh.share / NULLIF(fleet.fleet_share, 0))::numeric, 2)::float AS lift
       FROM veh JOIN fleet USING (component)
       WHERE veh.component <> 'UNKNOWN OR OTHER'
       ORDER BY veh.n DESC LIMIT 8`,
      [v.make, modelKey, v.year],
    );
    const totals = await this.one(
      `SELECT COUNT(*)::int AS complaints, COUNT(*) FILTER (WHERE crash)::int AS crashes,
              COUNT(*) FILTER (WHERE fire)::int AS fires
       FROM nhtsa_complaints WHERE make = $1 AND model = $2 AND ($3::int IS NULL OR model_year = $3)`,
      [v.make, modelKey, v.year],
    );
    const registry = await this.one(
      `SELECT COUNT(*)::int AS sealed_repairs, COUNT(DISTINCT vin)::int AS vins,
              COUNT(*) FILTER (WHERE severity = 'high')::int AS high_severity,
              (SELECT fault_code FROM proofs WHERE vehicle_make = $1 AND vehicle_model LIKE $2 || '%'
               GROUP BY fault_code ORDER BY COUNT(*) DESC LIMIT 1) AS most_common_fault
       FROM proofs WHERE vehicle_make = $1 AND vehicle_model LIKE $2 || '%'`,
      [v.make, modelKey],
    );
    const top = components[0];
    return {
      vehicle,
      parsed: v,
      matched: totals.complaints > 0,
      nhtsa: totals,
      components,
      registry,
      headline: top
        ? `${top.component} accounts for ${top.share_pct}% of NHTSA complaints for this model` +
          (top.lift ? ` (${top.lift}× the fleet average)` : "")
        : null,
    };
  }

  /** MechanicDB repair-knowledge analytics. */
  async dtc() {
    const [bySystem, families, costly, difficulty, severity] = await Promise.all([
      this.all(
        `SELECT system_category, COUNT(*)::int AS codes,
                COUNT(*) FILTER (WHERE is_oem_specific)::int AS oem_specific
         FROM dtc_codes GROUP BY 1 ORDER BY 2 DESC`,
      ),
      this.all(
        `SELECT fault_family, COUNT(*)::int AS codes FROM dtc_codes
         GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 12`,
      ),
      this.all(
        `SELECT d.dtc_code, d.short_description, f.fix_title,
                f.parts_cost_min_usd, f.parts_cost_max_usd, f.labor_hours, f.difficulty_level
         FROM dtc_codes d
         JOIN LATERAL (SELECT * FROM dtc_fixes f WHERE f.code_id = d.code_id
                       ORDER BY probability_rank NULLS LAST LIMIT 1) f ON true
         ORDER BY f.parts_cost_max_usd DESC NULLS LAST LIMIT 10`,
      ),
      this.all(
        `SELECT difficulty_level, COUNT(*)::int AS fixes,
                ROUND(AVG(labor_hours)::numeric, 2)::float AS avg_labor_hours,
                ROUND(AVG((parts_cost_min_usd + parts_cost_max_usd) / 2)::numeric, 0)::float AS avg_parts_cost_usd
         FROM dtc_fixes GROUP BY 1 ORDER BY avg_labor_hours`,
      ),
      this.all(
        `SELECT dtc_system, severity, COUNT(*)::int AS n,
                COUNT(*) FILTER (WHERE is_safety_critical)::int AS safety_critical
         FROM dtc_ft_examples GROUP BY 1, 2 ORDER BY 1, 3 DESC`,
      ),
    ]);
    return { by_system: bySystem, fault_families: families, most_expensive_first_fix: costly, difficulty, severity_labels: severity };
  }

  async dtcCode(code: string) {
    const c = code.toUpperCase();
    const codes = await this.all(`SELECT * FROM dtc_codes WHERE dtc_code = $1 ORDER BY is_oem_specific, code_id`, [c]);
    const fixes = await this.all(
      `SELECT f.*, COALESCE(json_agg(p.part_name ORDER BY p.part_id) FILTER (WHERE p.part_id IS NOT NULL), '[]') AS parts
       FROM dtc_fixes f JOIN dtc_codes d ON d.code_id = f.code_id
       LEFT JOIN dtc_parts p ON p.fix_id = f.fix_id
       WHERE d.dtc_code = $1 GROUP BY f.fix_id ORDER BY f.code_id, f.probability_rank NULLS LAST`,
      [c],
    );
    const labels = await this.all(
      `SELECT severity, dtc_system, is_safety_critical, COUNT(*)::int AS n FROM dtc_ft_examples
       WHERE dtc_code = $1 GROUP BY 1, 2, 3 ORDER BY n DESC`,
      [c],
    );
    const registry = await this.one(
      `SELECT COUNT(*)::int AS sealed, COUNT(DISTINCT vin)::int AS vins,
              ROUND(AVG(odometer_km))::int AS avg_odometer_km, ROUND(AVG(confidence)::numeric, 3)::float AS avg_confidence
       FROM proofs WHERE fault_code = $1`,
      [c],
    );
    return { dtc_code: c, known: codes.length > 0, definitions: codes, fixes, severity_labels: labels, registry };
  }

  /** UCI AI4I 2020 predictive-maintenance failure analytics. */
  async ai4i() {
    const [totals, modes, byType, byWear, byTorque] = await Promise.all([
      this.one(
        `SELECT COUNT(*)::int AS readings, COUNT(*) FILTER (WHERE machine_failure)::int AS failures,
                ROUND(100.0 * COUNT(*) FILTER (WHERE machine_failure) / NULLIF(COUNT(*), 0), 2)::float AS failure_rate_pct
         FROM ai4i_readings`,
      ),
      this.all(
        `SELECT mode, n::int FROM (
           SELECT 'Tool wear (TWF)' AS mode, COUNT(*) FILTER (WHERE twf) AS n FROM ai4i_readings UNION ALL
           SELECT 'Heat dissipation (HDF)', COUNT(*) FILTER (WHERE hdf) FROM ai4i_readings UNION ALL
           SELECT 'Power (PWF)', COUNT(*) FILTER (WHERE pwf) FROM ai4i_readings UNION ALL
           SELECT 'Overstrain (OSF)', COUNT(*) FILTER (WHERE osf) FROM ai4i_readings UNION ALL
           SELECT 'Random (RNF)', COUNT(*) FILTER (WHERE rnf) FROM ai4i_readings) m ORDER BY n DESC`,
      ),
      this.all(
        `SELECT quality_type, COUNT(*)::int AS readings,
                ROUND(100.0 * COUNT(*) FILTER (WHERE machine_failure) / COUNT(*), 2)::float AS failure_rate_pct
         FROM ai4i_readings GROUP BY 1 ORDER BY 1`,
      ),
      this.all(
        `SELECT (width_bucket(tool_wear_min, 0, 250, 10) - 1) * 25 AS wear_from_min, COUNT(*)::int AS readings,
                ROUND(100.0 * COUNT(*) FILTER (WHERE machine_failure) / COUNT(*), 2)::float AS failure_rate_pct
         FROM ai4i_readings GROUP BY 1 ORDER BY 1`,
      ),
      this.all(
        `SELECT (width_bucket(torque_nm, 0, 80, 8) - 1) * 10 AS torque_from_nm, COUNT(*)::int AS readings,
                ROUND(100.0 * COUNT(*) FILTER (WHERE machine_failure) / COUNT(*), 2)::float AS failure_rate_pct
         FROM ai4i_readings GROUP BY 1 ORDER BY 1`,
      ),
    ]);
    return { totals, failure_modes: modes, by_quality_type: byType, by_tool_wear: byWear, by_torque: byTorque };
  }

  async models() {
    return this.all(`SELECT * FROM model_benchmarks ORDER BY benchmark, fault_code_accuracy DESC NULLS LAST`);
  }

  async datasets() {
    return this.all(`SELECT dataset, source_path, row_count, source_sha256, loaded_at FROM etl_runs ORDER BY dataset`);
  }
}
