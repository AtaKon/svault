import type { Request, RequestHandler } from "express";
import { ApiError } from "./http.js";

/**
 * Small in-memory, fixed-window rate limiter. SVault runs as a single process,
 * so there is no need for a shared store; counters reset on restart.
 *
 * Limits are configured per limiter with `SV_RATE_LIMIT_<NAME>=<max>/<seconds>`
 * (for example `SV_RATE_LIMIT_LOGIN=30/600`). `SV_RATE_LIMIT=off` disables
 * every limiter. Under NODE_ENV=test limiters are off unless SV_RATE_LIMIT=on.
 */

export interface LimitRule {
  max: number;
  windowMs: number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

export class RateLimitError extends ApiError {
  retryAfter: number;
  constructor(retryAfter: number, message?: string) {
    super(429, message ?? `Too many requests. Try again in ${retryAfter} seconds.`);
    this.retryAfter = retryAfter;
  }
}

export function rateLimitEnabled(): boolean {
  const flag = (process.env.SV_RATE_LIMIT ?? "").trim().toLowerCase();
  if (["off", "false", "0", "no"].includes(flag)) return false;
  if (process.env.NODE_ENV === "test") return ["on", "true", "1", "yes"].includes(flag);
  return true;
}

function parseRule(value: string | undefined, fallback: LimitRule): LimitRule {
  const match = String(value ?? "").trim().match(/^(\d+)\s*\/\s*(\d+)\s*s?$/i);
  if (!match) return fallback;
  const max = Number(match[1]);
  const seconds = Number(match[2]);
  if (!(max > 0) || !(seconds > 0)) return fallback;
  return { max, windowMs: seconds * 1000 };
}

export class RateLimiter {
  private buckets = new Map<string, Bucket>();
  private hits = 0;

  constructor(
    readonly name: string,
    private readonly fallback: LimitRule,
  ) {}

  rule(): LimitRule {
    return parseRule(process.env[`SV_RATE_LIMIT_${this.name}`], this.fallback);
  }

  private sweep(now: number) {
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
  }

  private bucket(key: string, now: number): Bucket | undefined {
    const bucket = this.buckets.get(key);
    if (bucket && bucket.resetAt <= now) {
      this.buckets.delete(key);
      return undefined;
    }
    return bucket;
  }

  /** Seconds to wait when the key is already over its limit, otherwise 0. Does not count. */
  blocked(key: string): number {
    if (!rateLimitEnabled()) return 0;
    const now = Date.now();
    const bucket = this.bucket(key, now);
    if (!bucket || bucket.count < this.rule().max) return 0;
    return Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
  }

  /** Count one request. Returns seconds to wait when this request is over the limit, otherwise 0. */
  hit(key: string): number {
    if (!rateLimitEnabled()) return 0;
    const now = Date.now();
    if (++this.hits % 500 === 0 || this.buckets.size > 10_000) this.sweep(now);
    const rule = this.rule();
    let bucket = this.bucket(key, now);
    if (!bucket) {
      bucket = { count: 0, resetAt: now + rule.windowMs };
      this.buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count <= rule.max) return 0;
    return Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
  }

  reset(key: string) {
    this.buckets.delete(key);
  }
}

export function clientIp(req: Request): string {
  return req.ip || req.socket.remoteAddress || "unknown";
}

/** Express middleware counting every request under `key(req)`. */
export function limitRequests(
  limiter: RateLimiter,
  key: (req: Request) => string = clientIp,
  message?: string,
): RequestHandler {
  return (req, _res, next) => {
    const wait = limiter.hit(key(req));
    if (wait > 0) {
      next(new RateLimitError(wait, message));
      return;
    }
    next();
  };
}

/* The limiters SVault uses. Defaults are generous for a household and tight
   enough to make password, TOTP and invite-code guessing impractical. */
export const limiters = {
  /** Every login attempt, per client IP. */
  login: new RateLimiter("LOGIN", { max: 30, windowMs: 10 * 60_000 }),
  /** Failed logins per account identifier, so one account cannot be brute-forced from many IPs. */
  loginAccount: new RateLimiter("LOGIN_ACCOUNT", { max: 10, windowMs: 15 * 60_000 }),
  register: new RateLimiter("REGISTER", { max: 10, windowMs: 60 * 60_000 }),
  twoFactor: new RateLimiter("TWO_FACTOR", { max: 20, windowMs: 10 * 60_000 }),
  passkey: new RateLimiter("PASSKEY", { max: 30, windowMs: 10 * 60_000 }),
  invite: new RateLimiter("INVITE", { max: 30, windowMs: 10 * 60_000 }),
  /** AI-backed endpoints, per signed-in user (or IP). They can cost real money. */
  ai: new RateLimiter("AI", { max: 60, windowMs: 10 * 60_000 }),
};

export const userOrIp = (req: Request) => (req.user ? `user:${req.user.id}` : `ip:${clientIp(req)}`);
