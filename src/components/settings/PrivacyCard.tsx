import Link from "next/link";
import { ShieldCheck } from "lucide-react";
import { Card, CardTitle } from "@/components/ui/bits";

/**
 * AI data-use & privacy settings surface. States current guarantees and
 * placeholders honestly — no compliance claims are made anywhere here.
 */
export function PrivacyCard() {
  const Row = ({ label, value }: { label: string; value: React.ReactNode }) => (
    <div className="flex items-start justify-between gap-3 border-t border-hairline-2 py-[8px] first:border-t-0">
      <span className="text-[12px] text-body">{label}</span>
      <span className="max-w-[220px] text-right text-[12px] font-semibold text-ink">{value}</span>
    </div>
  );

  return (
    <div className="mx-auto max-w-[420px] px-6 pb-6">
      <Card className="px-4 py-[14px]">
        <CardTitle className="mb-[4px]">
          <ShieldCheck size={13} strokeWidth={2} className="text-brand" aria-hidden />
          AI data use &amp; privacy
        </CardTitle>
        <p className="mt-0 mb-[8px] text-[11px] leading-[1.5] text-subtle">
          Current policy surface. No compliance certification is claimed here; see the AI
          registry for per-feature governance.
        </p>
        <Row label="Patient data used to train external models" value={<span className="text-positive">Never</span>} />
        <Row label="Region / data residency" value="us-east-2 (placeholder — confirmed at deploy)" />
        <Row
          label="AI feature registry"
          value={
            <Link href="/ai-safety" className="text-action hover:text-action-deep focus-visible:outline-2 focus-visible:outline-action">
              View registry →
            </Link>
          }
        />
        <Row label="Audit logging" value="Demo session log active; backend append-only audit pending tRPC" />
        <Row label="PHI in logs" value={<span className="text-positive">Blocked (scrubber policy)</span>} />
        <Row label="Patient export request" value="Placeholder — ships with patient-rights backend" />
        <Row label="Patient deletion request" value="Placeholder — ships with patient-rights backend" />
      </Card>
    </div>
  );
}
