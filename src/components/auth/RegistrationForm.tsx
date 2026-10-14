"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Card } from "@/components/ui/bits";

type Step = "start" | "confirm" | "complete";

const inputClass = "h-10 w-full rounded-lg border border-line bg-card px-3 text-[13px] text-body outline-none focus-visible:outline-2 focus-visible:outline-action";

export function RegistrationForm() {
  const [interactive, setInteractive] = useState(false);
  const [step, setStep] = useState<Step>("start");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [working, setWorking] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setInteractive(true), []);

  async function request(action: "start" | "confirm" | "resend") {
    if (!interactive || working) return;
    setWorking(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action, email,
          ...(action === "start" ? { password } : {}),
          ...(action === "confirm" ? { code } : {}),
        }),
      });
      const result = (await response.json().catch(() => ({}))) as {
        data?: { message?: string; confirmed?: boolean };
        error?: { message?: string };
      };
      if (!response.ok) {
        setError(result.error?.message ?? "Registration could not be completed. Try again later.");
        return;
      }
      if (action === "start") {
        setPassword("");
        setStep("confirm");
      } else if (action === "confirm" && result.data?.confirmed) {
        setCode("");
        setStep("complete");
      }
      setNotice(result.data?.message ?? (action === "confirm" ? "Email confirmed." : null));
    } catch {
      setError("The registration service is unreachable right now. Please try again.");
    } finally {
      setWorking(false);
    }
  }

  if (step === "complete") {
    return <Card className="px-4 py-4">
      <p role="status" className="m-0 text-[13px] font-semibold text-body">Your email is confirmed.</p>
      <p className="mt-2 text-[12px] leading-[1.5] text-subtle">
        An account does not grant patient access. A clinic administrator must add and approve your organization membership first.
        You will also set up an authenticator when you sign in.
      </p>
      <Link href="/login" className="mt-3 inline-flex h-9 items-center rounded-lg bg-action px-4 text-[12px] font-semibold text-white">Go to sign in</Link>
    </Card>;
  }

  return <Card className="px-4 py-4">
    <p className="m-0 mb-3 text-[12px] leading-[1.5] text-subtle">
      Create a practitioner sign-in, then verify your email. A clinic administrator must approve your membership
      before you can see patient information. Do not enter patient information here.
    </p>
    <form onSubmit={(event) => { event.preventDefault(); void request(step); }} className="flex flex-col gap-3">
      {!interactive ? <p role="status" className="text-[12px] text-subtle">Preparing secure registration…</p> : null}
      <label className="block">
        <span className="mb-1 block text-[11px] font-semibold text-body">Email</span>
        <input type="email" autoComplete="email" required maxLength={254} value={email}
          disabled={!interactive || working} onChange={(event) => setEmail(event.target.value)} className={inputClass} />
      </label>
      {step === "start" ? <label className="block">
        <span className="mb-1 block text-[11px] font-semibold text-body">Password</span>
        <input type="password" autoComplete="new-password" required minLength={14} maxLength={128}
          value={password} disabled={!interactive || working}
          onChange={(event) => setPassword(event.target.value)} className={inputClass} />
        <span className="mt-1 block text-[11px] text-subtle">At least 14 characters with uppercase, lowercase, a number and a symbol.</span>
      </label> : <label className="block">
        <span className="mb-1 block text-[11px] font-semibold text-body">Six-digit email code</span>
        <input inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6}
          required value={code} disabled={!interactive || working}
          onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))} className={inputClass} />
      </label>}
      {error ? <p role="alert" className="m-0 rounded-lg bg-critical-tint px-3 py-2 text-[12px] text-critical">{error}</p> : null}
      {notice ? <p role="status" className="m-0 rounded-lg bg-positive-tint px-3 py-2 text-[12px] text-body">{notice}</p> : null}
      <button type="submit" disabled={!interactive || working}
        className="h-10 rounded-lg border-none bg-action px-4 text-[13px] font-semibold text-white disabled:opacity-50">
        {working ? "Working…" : step === "start" ? "Create account" : "Confirm email"}
      </button>
    </form>
    {step === "confirm" ? <div className="mt-3 flex gap-3 text-[12px]">
      <button type="button" onClick={() => void request("resend")} disabled={working}
        className="border-none bg-transparent p-0 font-semibold text-action disabled:opacity-50">Resend code</button>
      <button type="button" onClick={() => { setStep("start"); setError(null); setNotice(null); }}
        className="border-none bg-transparent p-0 text-subtle">Use another email</button>
    </div> : <button type="button" onClick={() => { setStep("confirm"); setError(null); setNotice(null); }}
      className="mt-3 border-none bg-transparent p-0 text-[12px] font-semibold text-action">Already have a code?</button>}
    <p className="mb-0 mt-3 border-t border-hairline pt-3 text-[12px] text-subtle">
      Already registered? <Link href="/login" className="font-semibold text-action">Sign in</Link>
    </p>
  </Card>;
}
