import type { NextFunction, Request, RequestHandler, Response } from "express";
import { z } from "zod";
import { memberRole, roleAtLeast } from "./auth.js";
import type { Role } from "../shared/types.js";

export class ApiError extends Error {
  status: number;
  details?: unknown;
  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export function notFound(message = "Not found"): never {
  throw new ApiError(404, message);
}

export function badRequest(message: string, details?: unknown): never {
  throw new ApiError(400, message, details);
}

export function forbidden(message = "You do not have access to this resource"): never {
  throw new ApiError(403, message);
}

export function parseBody<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ApiError(400, "Invalid request", result.error.flatten());
  }
  return result.data;
}

/** Express 5 forwards rejected promises automatically, but this keeps types tidy. */
export function handler(fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown> | unknown): RequestHandler {
  return (req, res, next) => {
    void Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/** Resolve a house the caller can access, or throw 403/404. */
export async function requireHouse(req: Request, minRole: Role = "viewer") {
  const houseId = String(req.params.houseId ?? req.params.id ?? "");
  const user = req.user!;
  const role = await memberRole(user.id, houseId);
  if (!role) throw new ApiError(404, "House not found");
  if (!roleAtLeast(role, minRole)) throw new ApiError(403, `Requires ${minRole} access`);
  return { houseId, role };
}

/** Instance-wide operations (backups, catalogue maintenance) need the instance admin. */
export function requireInstanceAdmin(req: Request): void {
  if (!req.user) throw new ApiError(401, "Not signed in");
  if (!req.user.isAdmin) throw new ApiError(403, "Requires the instance administrator");
}

export function intParam(value: unknown, fallback: number, max = 200): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
