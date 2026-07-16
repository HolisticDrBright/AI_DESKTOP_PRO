import Link from "next/link";
import { KeyRound } from "lucide-react";
import { USE_LIVE_API } from "@/adapters/mode";
import { Card } from "@/components/ui/bits";
import { LoginForm } from "@/components/auth/LoginForm";

/**
 * Practitioner sign-in for LIVE mode (real Supabase Auth against the clinical
 * project, handled server-side — tokens live in httpOnly cookies). Demo mode
 * needs no sign-in, and this page says so instead of pretending otherwise.
 */
export default function LoginPage() {
  return (
    <section data-screen-label="Sign in" className="mx-auto max-w-[420px] px-6 pt-[48px] pb-10">
      <div className="mb-4 flex items-center gap-[8px]">
        <KeyRound size={18} strokeWidth={2} className="text-brand" aria-hidden />
        <h1 className="m-0 text-[21px] font-bold tracking-[-0.015em]">Practitioner sign-in</h1>
      </div>

      {USE_LIVE_API ? (
        <LoginForm />
      ) : (
        <Card className="px-4 py-[16px]">
          <p className="m-0 text-[13px] leading-[1.55] text-body">
            This build is running in <strong className="font-semibold">demo mode</strong> — all
            data is synthetic and session-only, so no sign-in is required.
          </p>
          <p className="mt-[8px] mb-0 text-[12px] leading-[1.5] text-subtle">
            Live mode (NEXT_PUBLIC_USE_LIVE_API=true) uses real practitioner sign-in against the
            clinical project. See Settings → Data source &amp; environment.
          </p>
          <Link
            href="/"
            className="mt-[12px] inline-flex h-9 items-center rounded-lg border-none bg-action px-4 text-[12.5px] font-semibold text-white hover:bg-action-deep focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
          >
            Back to the app
          </Link>
        </Card>
      )}
    </section>
  );
}
