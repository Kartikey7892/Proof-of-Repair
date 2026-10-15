/** FastAPI-compatible errors: every failure is JSON `{ "detail": ... }`. */
import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from "express";
import { z } from "zod";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly detail: unknown,
  ) {
    super(typeof detail === "string" ? detail : "request failed");
  }
}

export function parseBody<S extends z.ZodType>(schema: S, body: unknown): z.output<S> {
  const r = schema.safeParse(body ?? {});
  if (!r.success) {
    // Same shape FastAPI uses for 422 validation errors.
    throw new HttpError(
      422,
      r.error.issues.map((i) => ({ loc: ["body", ...i.path.map(String)], msg: i.message, type: i.code })),
    );
  }
  return r.data;
}

export const asyncRoute =
  (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler =>
  (req, res, next: NextFunction) => {
    fn(req, res).catch(next);
  };

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({ detail: err.detail });
    return;
  }
  // body-parser JSON syntax errors
  if (err?.type === "entity.parse.failed") {
    res.status(422).json({ detail: [{ loc: ["body"], msg: "invalid JSON", type: "json_invalid" }] });
    return;
  }
  const status = typeof err?.status === "number" && err.status >= 400 && err.status < 600 ? err.status : 500;
  if (status >= 500) console.error("[api]", err);
  res.status(status).json({ detail: err?.message ?? "internal error" });
};
