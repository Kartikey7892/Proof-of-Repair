/**
 * PostgreSQL schema. Append new migrations; never edit an applied one.
 *
 * 1. Core registry — proofs, Merkle anchors, evidence metadata. Unlike the
 *    Python SQLite version, Merkle inclusion proofs are persisted per proof, so
 *    any anchored proof can be verified after a restart (not just the last batch).
 * 2. Analytics — real datasets shipped in data/raw + model benchmark results,
 *    loaded by the ETL (scripts/etl.ts), plus VIN-lookup demand events.
 */
export const MIGRATIONS: { version: number; name: string; sql: string }[] = [
  {
    version: 1,
    name: "core_registry",
    sql: `
CREATE TABLE proofs (
  proof_id          TEXT PRIMARY KEY,
  vin               TEXT NOT NULL,
  vehicle           TEXT,
  vehicle_year      INTEGER,
  vehicle_make      TEXT,
  vehicle_model     TEXT,
  odometer_km       INTEGER,
  event_type        TEXT,
  issuer_id         TEXT,
  ts                DOUBLE PRECISION NOT NULL,
  sealed_at         TIMESTAMPTZ NOT NULL,
  leaf_digest       TEXT NOT NULL,
  report_hash       TEXT NOT NULL,
  evidence_cid      TEXT,
  fault_code        TEXT,
  severity          TEXT,
  diagnosis         TEXT,
  buyer_advice      TEXT,
  confidence        DOUBLE PRECISION,
  estimated_minutes INTEGER,
  engine            TEXT,
  diagnosis_ms      INTEGER,
  report            JSONB NOT NULL,
  model             JSONB NOT NULL DEFAULT '{}'::jsonb,
  extra             JSONB NOT NULL DEFAULT '{}'::jsonb,
  proof             JSONB NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_proofs_vin ON proofs (vin);
CREATE INDEX idx_proofs_leaf ON proofs (leaf_digest);
CREATE INDEX idx_proofs_sealed ON proofs (sealed_at);
CREATE INDEX idx_proofs_fault ON proofs (fault_code);
CREATE INDEX idx_proofs_make_model ON proofs (vehicle_make, vehicle_model);

CREATE TABLE anchors (
  batch_id        TEXT PRIMARY KEY,
  merkle_root     TEXT NOT NULL,
  leaf_count      INTEGER NOT NULL,
  leaf_order      JSONB NOT NULL,
  ots_receipt_id  TEXT,
  ots_status      TEXT,
  ots_mode        TEXT,
  ots_receipt     JSONB,
  chain_tx        TEXT,
  chain_network   TEXT,
  chain_mode      TEXT,
  chain_receipt   JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_anchors_root ON anchors (merkle_root);

CREATE TABLE proof_anchors (
  proof_id      TEXT NOT NULL REFERENCES proofs (proof_id) ON DELETE CASCADE,
  batch_id      TEXT NOT NULL REFERENCES anchors (batch_id) ON DELETE CASCADE,
  leaf_index    INTEGER NOT NULL,
  merkle_proof  JSONB NOT NULL,
  PRIMARY KEY (proof_id, batch_id)
);
CREATE INDEX idx_proof_anchors_batch ON proof_anchors (batch_id);

CREATE TABLE evidence (
  cid         TEXT PRIMARY KEY,
  size_bytes  INTEGER NOT NULL,
  meta        JSONB NOT NULL DEFAULT '{}'::jsonb,
  stored_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
`,
  },
  {
    version: 2,
    name: "analytics_datasets",
    sql: `
CREATE TABLE vin_lookups (
  id           BIGSERIAL PRIMARY KEY,
  vin          TEXT NOT NULL,
  result_count INTEGER NOT NULL,
  trust        TEXT NOT NULL,
  looked_up_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_vin_lookups_at ON vin_lookups (looked_up_at);

CREATE TABLE nhtsa_complaints (
  odi_number    BIGINT PRIMARY KEY,
  make          TEXT NOT NULL,
  model         TEXT NOT NULL,
  model_year    INTEGER NOT NULL,
  manufacturer  TEXT,
  components    TEXT,
  crash         BOOLEAN NOT NULL DEFAULT false,
  fire          BOOLEAN NOT NULL DEFAULT false,
  injuries      INTEGER NOT NULL DEFAULT 0,
  deaths        INTEGER NOT NULL DEFAULT 0,
  incident_date DATE,
  filed_date    DATE,
  vin_prefix    TEXT,
  summary       TEXT
);
CREATE INDEX idx_nhtsa_vehicle ON nhtsa_complaints (make, model, model_year);

CREATE TABLE nhtsa_complaint_components (
  odi_number BIGINT NOT NULL REFERENCES nhtsa_complaints (odi_number) ON DELETE CASCADE,
  component  TEXT NOT NULL,
  PRIMARY KEY (odi_number, component)
);
CREATE INDEX idx_nhtsa_component ON nhtsa_complaint_components (component);

CREATE TABLE dtc_codes (
  code_id          INTEGER PRIMARY KEY,
  dtc_code         TEXT NOT NULL,
  system_category  TEXT,
  is_oem_specific  BOOLEAN NOT NULL DEFAULT false,
  oem_make         TEXT,
  fault_family     TEXT,
  short_description TEXT,
  explanation      TEXT
);
CREATE INDEX idx_dtc_codes_code ON dtc_codes (dtc_code);

CREATE TABLE dtc_fixes (
  fix_id            INTEGER PRIMARY KEY,
  code_id           INTEGER NOT NULL REFERENCES dtc_codes (code_id) ON DELETE CASCADE,
  fix_title         TEXT NOT NULL,
  probability_rank  INTEGER,
  difficulty_level  TEXT,
  parts_cost_min_usd DOUBLE PRECISION,
  parts_cost_max_usd DOUBLE PRECISION,
  labor_hours       DOUBLE PRECISION,
  steps             TEXT
);
CREATE INDEX idx_dtc_fixes_code ON dtc_fixes (code_id, probability_rank);

CREATE TABLE dtc_parts (
  part_id    INTEGER PRIMARY KEY,
  fix_id     INTEGER NOT NULL REFERENCES dtc_fixes (fix_id) ON DELETE CASCADE,
  part_name  TEXT NOT NULL,
  search_url TEXT
);
CREATE INDEX idx_dtc_parts_fix ON dtc_parts (fix_id);

CREATE TABLE dtc_ft_examples (
  id                 SERIAL PRIMARY KEY,
  split              TEXT NOT NULL,
  dtc_code           TEXT,
  dtc_system         TEXT,
  severity           TEXT,
  category           TEXT,
  vehicle            TEXT,
  is_safety_critical BOOLEAN
);
CREATE INDEX idx_dtc_ft_code ON dtc_ft_examples (dtc_code);

CREATE TABLE ai4i_readings (
  udi              INTEGER PRIMARY KEY,
  product_id       TEXT,
  quality_type     TEXT,
  air_temp_k       DOUBLE PRECISION,
  process_temp_k   DOUBLE PRECISION,
  rotational_rpm   INTEGER,
  torque_nm        DOUBLE PRECISION,
  tool_wear_min    INTEGER,
  machine_failure  BOOLEAN,
  twf BOOLEAN, hdf BOOLEAN, pwf BOOLEAN, osf BOOLEAN, rnf BOOLEAN
);

CREATE TABLE model_benchmarks (
  benchmark                TEXT NOT NULL,
  model                    TEXT NOT NULL,
  n                        INTEGER,
  fault_code_accuracy      DOUBLE PRECISION,
  json_validity_rate       DOUBLE PRECISION,
  schema_completeness_rate DOUBLE PRECISION,
  severity_accuracy        DOUBLE PRECISION,
  rouge_l_repair_steps     DOUBLE PRECISION,
  errors                   INTEGER,
  PRIMARY KEY (benchmark, model)
);

CREATE TABLE etl_runs (
  dataset     TEXT PRIMARY KEY,
  source_path TEXT NOT NULL,
  source_sha256 TEXT NOT NULL,
  row_count   INTEGER NOT NULL,
  loaded_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
`,
  },
];
