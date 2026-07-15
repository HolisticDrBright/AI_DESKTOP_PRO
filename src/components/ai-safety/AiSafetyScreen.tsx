import { Info, ShieldCheck } from "lucide-react";
import {
  AI_FEATURES,
  type AiFeatureClassification,
  type Determinism,
  type RiskLevel,
} from "@/lib/ai-safety";
import type { Tone } from "@/adapters/types";
import { Card } from "@/components/ui/bits";
import { toneText, toneTint } from "@/lib/tones";

const RISK_TONE: Record<RiskLevel, Tone> = {
  Low: "positive",
  Moderate: "warning",
  High: "critical",
};

const DETERMINISM_TONE: Record<Determinism, Tone> = {
  Deterministic: "slate",
  AI: "ai",
  Hybrid: "action",
};

function Badge({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return (
    <span
      className="rounded-full px-[9px] py-[2px] text-[10.5px] font-bold"
      style={{ color: toneText[tone], background: toneTint[tone] }}
    >
      {children}
    </span>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] font-bold tracking-[0.04em] text-faint uppercase">{label}</div>
      <div className="mt-[2px] text-[12px] leading-[1.35] text-body">{children}</div>
    </div>
  );
}

export function AiSafetyScreen() {
  return (
    <section
      data-screen-label="AI Safety"
      className="relative mx-auto max-w-[1060px] px-6 pt-[24px] pb-10"
    >
      <div className="mb-1 text-[11.5px] font-semibold text-faint">System / AI Safety</div>
      <h1 className="m-0 text-[22px] font-bold tracking-[-0.015em]">
        AI &amp; decision-support registry
      </h1>
      <p className="mt-[6px] mb-4 max-w-[680px] text-[13px] leading-[1.5] text-subtle">
        Every place the product uses AI or automated reasoning, and how each is governed —
        who uses it, whether it reaches the patient, and the review and audit requirements
        that keep a human in the loop.
      </p>

      {/* Scope & limitations — makes no regulatory claims */}
      <div className="mb-5 flex items-start gap-3 rounded-[12px] border border-[rgba(199,126,20,0.28)] bg-warning-tint px-[16px] py-[13px]">
        <ShieldCheck size={17} strokeWidth={2} className="mt-px shrink-0 text-warning-deep" aria-hidden />
        <div className="text-[12px] leading-[1.5] text-warning-deep">
          <strong className="font-bold">Scope &amp; limitations.</strong> These features are
          clinical decision support, reviewed by a licensed practitioner. They are{" "}
          <strong className="font-bold">not</strong> a diagnosis, and outputs are not medical
          probabilities. This product is not described as HIPAA compliant, FDA cleared, SOC 2
          certified, or clinically validated. Reasoning strength is internal evidence
          weighting only.
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        {AI_FEATURES.map((f) => (
          <FeatureCard key={f.feature} feature={f} />
        ))}
      </div>

      <p className="mt-5 flex items-center gap-[6px] text-[11px] text-faint">
        <Info size={12} strokeWidth={2} aria-hidden />
        This registry is the source of truth for how AI outputs are labeled across the app.
      </p>
    </section>
  );
}

function FeatureCard({ feature: f }: { feature: AiFeatureClassification }) {
  return (
    <Card className="flex flex-col p-[16px]">
      <div className="mb-[10px] flex flex-wrap items-center gap-[7px]">
        <h2 className="m-0 mr-auto text-[13.5px] font-bold">{f.feature}</h2>
        <Badge tone={DETERMINISM_TONE[f.determinism]}>{f.determinism}</Badge>
        <Badge tone={RISK_TONE[f.risk]}>{f.risk} risk</Badge>
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-[10px]">
        <Field label="User role">{f.roles.join(", ")}</Field>
        <Field label="Patient-facing">
          <span className={f.patientFacing ? "font-semibold text-teal" : "font-semibold text-muted"}>
            {f.patientFacing ? "Yes — extra review gate" : "No"}
          </span>
        </Field>
        <Field label="Action">
          <span className="capitalize">{f.actionVerb}</span> · {f.outputType}
        </Field>
        <Field label="Review requirement">
          <span
            className={
              f.review === "Practitioner review required"
                ? "font-semibold text-action-deep"
                : f.review === "Review recommended"
                  ? "font-semibold text-warning-deep"
                  : "text-muted"
            }
          >
            {f.review}
          </span>
        </Field>
        <Field label="Audited">{f.audited ? "Yes" : "No"}</Field>
        <Field label="Inputs">
          <span className="flex flex-wrap gap-[4px]">
            {f.inputs.map((i) => (
              <span key={i} className="rounded-[5px] bg-sunken-2 px-[6px] py-px text-[10.5px] text-muted">
                {i}
              </span>
            ))}
          </span>
        </Field>
      </div>

      <div className="mt-[12px] border-t border-hairline-2 pt-[10px] text-[11px] leading-[1.45] text-subtle">
        <span className="font-semibold text-body-2">In-product disclaimer: </span>
        {f.disclaimer}
      </div>
    </Card>
  );
}
