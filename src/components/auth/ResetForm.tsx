"use client";

import { useState } from "react";
import Link from "next/link";

/**
 * Completes a Cognito workforce password reset with the one-time email code.
 */
export function ResetForm() {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [working, setWorking] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (working) return;
    setError("");
    if (!email.includes("@") || !/^\d{6}$/.test(code)) {
      setError("Enter your workforce email and the six-digit code from the reset email.");
      return;
    }
    if (password.length < 14) {
      setError("Choose a password of at least 14 characters.");
      return;
    }
    if (password !== confirm) {
      setError("The passwords don't match.");
      return;
    }
    setWorking(true);
    try {
      const res = await fetch("/api/auth/reset-complete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, confirmationCode: code, password }),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
      if (!res.ok) {
        setError(json.error?.message ?? "Could not update the password.");
        return;
      }
      setDone(true);
    } catch {
      setError("The reset service is unreachable right now. Please try again.");
    } finally {
      setWorking(false);
    }
  };

  if (done) {
    return (
      <div className="rounded-[12px] border border-[rgba(31,138,90,0.3)] bg-positive-tint px-4 py-[14px]">
        <p className="m-0 text-[13px] font-semibold text-ink">Password updated</p>
        <p className="m-0 mt-[6px] text-[12.5px] text-body">
          Sign in with your new password.
        </p>
        <Link
          href="/login"
          className="mt-3 inline-flex h-9 items-center rounded-lg border-none bg-action px-4 text-[12.5px] font-semibold text-white hover:bg-action-deep focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
        >
          Go to sign-in
        </Link>
      </div>
    );
  }

  const field =
    "h-9 w-full rounded-lg border border-line bg-card px-[10px] text-[13px] text-body outline-none focus-visible:border-action focus-visible:outline-2 focus-visible:outline-action";

  return (
    <form onSubmit={submit} className="flex flex-col gap-[12px]">
      <div>
        <label htmlFor="reset-email" className="mb-[5px] block text-[10px] font-bold tracking-[0.04em] text-faint uppercase">
          Workforce email
        </label>
        <input
          id="reset-email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className={field}
        />
      </div>
      <div>
        <label htmlFor="reset-code" className="mb-[5px] block text-[10px] font-bold tracking-[0.04em] text-faint uppercase">
          Six-digit reset code
        </label>
        <input
          id="reset-code"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]{6}"
          maxLength={6}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
          className={field}
        />
      </div>
      <div>
        <label htmlFor="new-password" className="mb-[5px] block text-[10px] font-bold tracking-[0.04em] text-faint uppercase">
          New password
        </label>
        <input
          id="new-password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className={field}
        />
      </div>
      <div>
        <label htmlFor="confirm-password" className="mb-[5px] block text-[10px] font-bold tracking-[0.04em] text-faint uppercase">
          Confirm password
        </label>
        <input
          id="confirm-password"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          className={field}
        />
      </div>
      {error && (
        <p role="alert" className="m-0 rounded-[9px] bg-critical-tint px-[11px] py-[9px] text-[12px] font-medium text-critical">
          {error}
        </p>
      )}
      <button
        type="submit"
        disabled={working}
        className="h-9 w-full cursor-pointer rounded-lg border-none bg-action text-[12.5px] font-semibold text-white hover:bg-action-deep focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:cursor-not-allowed disabled:opacity-50"
      >
        {working ? "Updating…" : "Set new password"}
      </button>
    </form>
  );
}
