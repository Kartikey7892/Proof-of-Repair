/** OpenAPI 3.1 document (request bodies generated from the zod schemas). */
import { z } from "zod";
import { AnchorBatchRequest, DiagnoseRequest, VerifyRequest } from "./schemas.js";

const body = (schema: z.ZodType) => ({
  required: true,
  content: { "application/json": { schema: z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) } },
});
const ok = (description: string) => ({ "200": { description } });
const get = (summary: string, tag: string, params: object[] = []) => ({
  get: { summary, tags: [tag], parameters: params, responses: ok(summary) },
});
const pathParam = (name: string, description: string) => ({ name, in: "path", required: true, description, schema: { type: "string" } });
const queryParam = (name: string, description: string, type = "string") => ({ name, in: "query", required: false, description, schema: { type } });

export function openApiDocument() {
  return {
    openapi: "3.1.0",
    info: {
      title: "Vehicle Proof of Repair API",
      version: "2.0.0",
      description:
        "Blockchain-anchored repair proofs for second-hand vehicle buyers. Node.js + Express + PostgreSQL. " +
        "Errors are JSON `{ detail }` (422 for validation errors), matching the original FastAPI service.",
    },
    tags: [{ name: "proofs" }, { name: "anchoring" }, { name: "analytics" }, { name: "system" }],
    paths: {
      "/api/health": get("Service, engine, chain, OTS and storage status", "system"),
      "/api/demo_cases": get("Demo vehicles for the workshop form", "system"),
      "/api/diagnose_and_prove": {
        post: {
          summary: "Diagnose a vehicle and seal a Proof of Repair to its VIN",
          tags: ["proofs"],
          requestBody: body(DiagnoseRequest),
          responses: { ...ok("engine, report, proof, pending_batch_size"), "400": { description: "engine unavailable" }, "422": { description: "validation error" } },
        },
      },
      "/api/anchor_batch": {
        post: {
          summary: "Merkle-batch pending proofs and anchor the root to OpenTimestamps + EVM",
          tags: ["anchoring"],
          requestBody: body(AnchorBatchRequest),
          responses: { ...ok("batch result with per-leaf inclusion proofs"), "400": { description: "nothing to anchor" }, "409": { description: "batch_id already used" } },
        },
      },
      "/api/verify": {
        post: {
          summary: "Independently verify report hash, leaf digest, evidence, Merkle inclusion and chain anchor",
          tags: ["proofs"],
          requestBody: body(VerifyRequest),
          responses: ok("per-check booleans and all_ok"),
        },
      },
      "/api/proofs": get("All sealed proofs (with anchor metadata)", "proofs", [queryParam("limit", "max rows (default 1000)", "integer")]),
      "/api/proofs/{proofId}": get("One proof", "proofs", [pathParam("proofId", "proof UUID")]),
      "/api/vin/{vin}": get("Buyer lookup: VIN repair-attestation timeline", "proofs", [pathParam("vin", "VIN (11+ chars)")]),
      "/api/last_batch": get("Most recently anchored batch", "anchoring"),
      "/api/evidence/{cid}": get("Raw content-addressed evidence JSON (integrity-checked)", "proofs", [pathParam("cid", "sha256 content id")]),
      "/api/ots/upgrade": { post: { summary: "Re-check pending OpenTimestamps receipts for Bitcoin confirmation", tags: ["anchoring"], responses: ok("upgrade results") } },
      "/api/analytics/overview": get("Registry KPIs, trends and mixes", "analytics", [queryParam("days", "trend window (default 30)", "integer")]),
      "/api/analytics/complaints": get("NHTSA complaint analytics", "analytics", [
        queryParam("make", "e.g. HONDA"),
        queryParam("model", "e.g. CIVIC"),
        queryParam("year", "model year", "integer"),
      ]),
      "/api/analytics/vehicle-risk": get("Buyer risk profile for a vehicle vs fleet", "analytics", [
        { ...queryParam("vehicle", "e.g. 2016 Honda Civic"), required: true },
      ]),
      "/api/analytics/dtc": get("MechanicDB repair-knowledge analytics", "analytics"),
      "/api/analytics/dtc/{code}": get("One DTC: definitions, ranked fixes, parts, severity labels, registry stats", "analytics", [pathParam("code", "OBD-II code, e.g. P0420")]),
      "/api/analytics/ai4i": get("AI4I 2020 failure-mode analytics", "analytics"),
      "/api/analytics/models": get("Fine-tuned model benchmark results", "analytics"),
      "/api/analytics/datasets": get("Loaded datasets and their source fingerprints (lineage)", "analytics"),
    },
  };
}

export const SWAGGER_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Proof of Repair API docs</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.17.14/swagger-ui.css"/></head>
<body><div id="ui"></div>
<script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.17.14/swagger-ui-bundle.js"></script>
<script>SwaggerUIBundle({ url: "/openapi.json", dom_id: "#ui" });</script>
</body></html>`;
