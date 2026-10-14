import Link from "next/link";
import { KeyRound } from "lucide-react";
import { USE_LIVE_API } from "@/adapters/mode";
import { Card } from "@/components/ui/bits";
import { RegistrationForm } from "@/components/auth/RegistrationForm";
import { WORKFORCE_SELF_SIGNUP_READY } from "@/server/clinical-core/workforce-self-signup-release";

export default function RegisterPage() {
  return <section data-screen-label="Practitioner registration" className="mx-auto max-w-[420px] px-6 pb-10 pt-[48px]">
    <div className="mb-4 flex items-center gap-2">
      <KeyRound size={18} strokeWidth={2} className="text-brand" aria-hidden />
      <h1 className="m-0 text-[21px] font-bold tracking-[-0.015em]">Create practitioner account</h1>
    </div>
    {USE_LIVE_API && !WORKFORCE_SELF_SIGNUP_READY ? <Card className="px-4 py-4">
      <p className="m-0 text-[13px] text-body">Practitioner self-registration is not open yet. Ask a clinic administrator to arrange access.</p>
      <Link href="/login" className="mt-3 inline-block text-[12px] font-semibold text-action">Back to sign in</Link>
    </Card> : USE_LIVE_API ? <RegistrationForm /> : <Card className="px-4 py-4">
      <p className="m-0 text-[13px] text-body">Demo mode uses synthetic data and does not create accounts.</p>
      <Link href="/" className="mt-3 inline-block text-[12px] font-semibold text-action">Back to the app</Link>
    </Card>}
  </section>;
}
