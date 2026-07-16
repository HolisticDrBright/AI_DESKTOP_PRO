"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { LogIn, LogOut } from "lucide-react";
import { Card } from "@/components/ui/bits";

/**
 * Email/password sign-in form (live mode). Credentials go only to the
 * same-origin /api/auth/login handler; tokens never reach this component —
 * the session lives in httpOnly cookies. Failures show the server's
 * clinician-safe message, never raw backend detail.
 */

interface SessionInfo {
  signedIn: boolean;
  email: string | null;
}

const inputCls =
  "h-10 w-full rounded-lg border border-line bg-card px-[11px] text-[13px] text-body outline-none focus-visible:outline-2 focus-visible:outline-action";

export function LoginForm() {
  const router = useRouter();
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/auth/session")
      .then((r) => r.json())
      .then((j) => alive && setSession({ signedIn: Boolean(j?.data?.signedIn), email: j?.data?.email ?? null }))
      .catch(() => alive && setSession({ signedIn: false, email: null }));
    return () => {
      alive = false;
    };
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        data?: { email?: string };
        error?: { message?: string };
      };
      if (!res.ok) {
        setError(json.error?.message ?? "Sign-in failed. Please try again.");
        return;
      }
      setSession({ signedIn: true, email: json.data?.email ?? email });
      router.push("/");
      router.refresh();
    } catch {
      setError("The sign-in service is unreachable right now. Please try again.");
    } finally {
      setPending(false);
    }
  };

  const signOut = async () => {
    setPending(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
      setSession({ signedIn: false, email: null });
      router.refresh();
    } finally {
      setPending(false);
    }
  };

  if (session?.signedIn) {
    return (
      <Card className="px-4 py-[16px]">
        <p className="m-0 text-[13px] text-body">
          Signed in as <strong className="font-semibold">{session.email ?? "practitioner"}</strong>.
        </p>
        <div className="mt-[12px] flex gap-2">
          <button
            onClick={() => router.push("/")}
            className="h-9 flex-1 cursor-pointer rounded-lg border-none bg-action px-4 text-[12.5px] font-semibold text-white hover:bg-action-deep focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
          >
            Open the app
          </button>
          <button
            onClick={signOut}
            disabled={pending}
            className="flex h-9 cursor-pointer items-center gap-[6px] rounded-lg border border-line bg-card px-4 text-[12.5px] font-semibold text-body hover:border-line-hover focus-visible:outline-2 focus-visible:outline-action disabled:opacity-50"
          >
            <LogOut size={13} strokeWidth={2} aria-hidden />
            Sign out
          </button>
        </div>
      </Card>
    );
  }

  return (
    <Card className="px-4 py-[16px]">
      <p className="mt-0 mb-[12px] text-[12.5px] leading-[1.5] text-subtle">
        Live mode — sign in with your practitioner account for the clinical project. Access is
        enforced by the backend and row-level security, not by this screen.
      </p>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <label className="block">
          <span className="mb-[4px] block text-[10.5px] font-bold tracking-[0.04em] text-faint uppercase">Email</span>
          <input
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className={inputCls}
          />
        </label>
        <label className="block">
          <span className="mb-[4px] block text-[10.5px] font-bold tracking-[0.04em] text-faint uppercase">Password</span>
          <input
            type="password"
            required
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={inputCls}
          />
        </label>
        {error && (
          <p role="alert" className="m-0 rounded-lg bg-critical-tint px-3 py-[8px] text-[12px] font-semibold text-critical">
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={pending}
          className="mt-1 flex h-10 items-center justify-center gap-[7px] rounded-lg border-none bg-action text-[13px] font-semibold text-white hover:bg-action-deep focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:cursor-not-allowed disabled:opacity-60"
        >
          <LogIn size={14} strokeWidth={2} aria-hidden />
          {pending ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </Card>
  );
}
