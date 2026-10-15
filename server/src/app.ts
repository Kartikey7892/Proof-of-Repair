import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import cors from "cors";
import express from "express";
import type { Analytics } from "./analytics/queries.js";
import { analyticsRouter } from "./http/analytics.js";
import { apiRouter, type ApiDeps } from "./http/api.js";
import { HttpError, errorHandler } from "./http/errors.js";
import { SWAGGER_HTML, openApiDocument } from "./http/openapi.js";

export interface AppDeps extends ApiDeps {
  analytics: Analytics;
  frontendDir?: string;
}

export function createApp(deps: AppDeps): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(cors());
  app.use(express.json({ limit: "1mb" }));

  app.use(apiRouter(deps));
  app.use("/api/analytics", analyticsRouter(deps.analytics));

  app.get("/openapi.json", (_req, res) => void res.json(openApiDocument()));
  app.get("/docs", (_req, res) => void res.type("html").send(SWAGGER_HTML));

  // Chart.js for the analytics dashboard, served from node_modules (no CDN needed).
  const require = createRequire(import.meta.url);
  const chartJs = path.join(path.dirname(require.resolve("chart.js")), "chart.umd.js");
  app.get("/vendor/chart.umd.js", (_req, res) => res.sendFile(chartJs));

  const fe = deps.frontendDir;
  if (fe && existsSync(fe)) {
    app.use("/assets", express.static(path.join(fe, "assets")));
    app.get("/", (_req, res) => res.sendFile(path.join(fe, "index.html")));
  }

  app.use("/api", (_req, _res, next) => next(new HttpError(404, "Not Found")));
  app.use(errorHandler);
  return app;
}
