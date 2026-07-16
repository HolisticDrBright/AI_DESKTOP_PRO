"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

/**
 * Completes a password reset. The one-time recovery token arrives in the URL
 * FRAGMENT of the emailed link (never sent to any server by the browser); it
 * is read here, used for exactly one reset-complete call, and never stored.
 */
export function ResetForm() {
  const [token, setToken] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [working, setWorking] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    setToken(params.get("access_token"));
    // Drop the fragment so the one-time token doesn't linger in the URL bar.
    if (params.get("access_token")) {
      window.history.replaceState(null, "", window.location.pathname);
    }
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (working) return;
    setError("");
    if (password.length < 8) {
      setError("Choose a password of at least 8 characters.");
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
        body: JSON.stringify({ accessToken: token, password }),
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

  if (token === null) {
    return (
      <div className="rounded-[12px] border border-line bg-card px-4 py-[14px]">
        <p className="m-0 text-[13px] font-semibold text-ink">Reset your password</p>
        <p className="m-0 mt-[6px] text-[12.5px] leading-[1.5] text-body">
          Open this page from the link in your reset email. If you don&apos;t have one,
          request it from the <Link href="/login" className="font-semibold text-action hover:underline">sign-in page</Link>.
        </p>
      </div>
    );
  }

  const field =
    "h-9 w-full rounded-lg border border-line bg-card px-[10px] text-[13px] text-body outline-none focus-visible:border-action focus-visible:outline-2 focus-visible:outline-action";

  return (
    <form onSubmit={submit} className="flex flex-col gap-[12px]">
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
