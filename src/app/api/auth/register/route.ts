import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { AdapterError, HTTP_STATUS, toAdapterError } from "@/adapters/errors";
import { USE_LIVE_API } from "@/adapters/mode";
import {
  confirmPractitionerEmail,
  registerPractitioner,
  resendPractitionerCode,
} from "@/adapters/auth.server";
import { readBoundedRequestBody } from "@/server/bounded-request-body";
import { sameBrowserOrigin } from "@/server/same-browser-origin";
import { WORKFORCE_SELF_SIGNUP_READY } from "@/server/clinical-core/workforce-self-signup-release";

/** Public identity enrollment only; clinic access still needs admin membership. */
const MAX_BODY_BYTES = 2048;
const WINDOW_MS = 15 * 60_000;
const attempts = new Map<string, { count: number; resetAt: number }>();

function takeAttempt(key: string, limit: number, now: number): boolean {
  if (attempts.size >= 10_000) {
    for (const [entry, value] of attempts) if (value.resetAt <= now) attempts.delete(entry);
    if (attempts.size >= 10_000 && !attempts.has(key)) return false;
  }
  const value = attempts.get(key);
  if (!value || value.resetAt <= now) {
    attempts.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return true;
  }
  if (value.count >= limit) return false;
  value.count += 1;
  return true;
}

function refuse(error: AdapterError, status = HTTP_STATUS[error.code]) {
  return NextResponse.json(error.toJSON(), { status, headers: { "cache-control": "no-store" } });
}

export async function POST(req: NextRequest) {
  if (!USE_LIVE_API) return refuse(new AdapterError("unavailable", "Registration is unavailable in demo mode."));
  if (!WORKFORCE_SELF_SIGNUP_READY) return refuse(new AdapterError("unavailable", "Practitioner registration is not open yet. Contact your clinic administrator."));
  if (!sameBrowserOrigin(req)) {
    return refuse(new AdapterError("forbidden", "Cross-origin registration is not allowed."));
  }
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers.get("content-type") ?? "") ||
      req.headers.has("content-encoding")) {
    return refuse(new AdapterError("invalid", "A JSON request is required."));
  }

  try {
    const bytes = await readBoundedRequestBody(req, MAX_BODY_BYTES, 5000);
    const body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as Record<string, unknown>;
    if (!body || Array.isArray(body) || typeof body !== "object") {
      throw new AdapterError("invalid", "Registration details are invalid.");
    }
    const action = body.action;
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 ||
        !["start", "confirm", "resend"].includes(String(action))) {
      throw new AdapterError("invalid", "Registration details are invalid.");
    }
    const ip = (req.headers.get("x-forwarded-for")?.split(",")[0] ?? "local").trim().slice(0, 128);
    const emailKey = createHash("sha256").update(email).digest("hex");
    const now = Date.now();
    if (!takeAttempt(`ip:${ip}`, 30, now) || !takeAttempt(`email:${emailKey}:${action}`, action === "confirm" ? 10 : 4, now)) {
      return refuse(new AdapterError("unavailable", "Too many attempts. Please try again later."), 429);
    }

    if (action === "start") {
      const password = body.password;
      if (typeof password !== "string" || password.length < 14 || password.length > 128 ||
          !/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password) ||
          !/[^A-Za-z0-9]/.test(password)) {
        throw new AdapterError("invalid", "Use at least 14 characters, including uppercase, lowercase, a number and a symbol.");
      }
      await registerPractitioner(email, password);
      return NextResponse.json({ data: { message: "If registration can proceed, a six-digit code will be sent to your email." } },
        { status: 202, headers: { "cache-control": "no-store" } });
    }
    if (action === "resend") {
      await resendPractitionerCode(email);
      return NextResponse.json({ data: { message: "If this account is awaiting confirmation, a new code will be sent." } },
        { status: 202, headers: { "cache-control": "no-store" } });
    }
    if (typeof body.code !== "string" || !/^\d{6}$/.test(body.code)) {
      throw new AdapterError("invalid", "Enter the six-digit email code.");
    }
    await confirmPractitionerEmail(email, body.code);
    return NextResponse.json({ data: { confirmed: true, membershipApproved: false } },
      { headers: { "cache-control": "no-store" } });
  } catch (error) {
    const mapped = toAdapterError(error, "invalid");
    return refuse(mapped);
  }
}
