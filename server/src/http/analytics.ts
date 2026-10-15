import { Router } from "express";
import { z } from "zod";
import type { Analytics } from "../analytics/queries.js";
import { HttpError, asyncRoute } from "./errors.js";

export function analyticsRouter(a: Analytics): Router {
  const r = Router();
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

  r.get(
    "/overview",
    asyncRoute(async (req, res) => {
      const days = z.coerce.number().int().min(1).max(365).catch(30).parse(req.query.days);
      res.json(await a.overview(days));
    }),
  );

  r.get(
    "/complaints",
    asyncRoute(async (req, res) => {
      const year = z.coerce.number().int().min(1950).max(2100).optional().catch(undefined).parse(req.query.year);
      res.json(await a.complaints({ make: str(req.query.make), model: str(req.query.model), year }));
    }),
  );

  r.get(
    "/vehicle-risk",
    asyncRoute(async (req, res) => {
      const vehicle = str(req.query.vehicle);
      if (!vehicle) throw new HttpError(400, "vehicle query parameter required, e.g. ?vehicle=2016 Honda Civic");
      res.json(await a.vehicleRisk(vehicle));
    }),
  );

  r.get("/dtc", asyncRoute(async (_req, res) => void res.json(await a.dtc())));

  r.get(
    "/dtc/:code",
    asyncRoute(async (req, res) => {
      const code = String(req.params.code).toUpperCase();
      if (!/^[PCBU][0-9A-F]{4}$/.test(code)) throw new HttpError(400, "expected an OBD-II code like P0420");
      res.json(await a.dtcCode(code));
    }),
  );

  r.get("/ai4i", asyncRoute(async (_req, res) => void res.json(await a.ai4i())));
  r.get("/models", asyncRoute(async (_req, res) => void res.json(await a.models())));
  r.get("/datasets", asyncRoute(async (_req, res) => void res.json(await a.datasets())));

  return r;
}
