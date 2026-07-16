import { Mars, Venus } from "lucide-react";
import type { PatientDirectoryEntry } from "@/adapters/types";
import { InitialsAvatar } from "@/components/ui/bits";
import { PatientHeaderActions } from "./PatientHeaderActions";

export function PatientHeaderCard({ patient }: { patient: PatientDirectoryEntry }) {
  const SexGlyph = patient.sex === "Female" ? Venus : Mars;
  return (
    <div className="glassable flex items-center gap-[22px] rounded-2xl border border-line bg-[rgba(255,255,255,0.92)] px-[22px] py-[18px] shadow-[0_1px_2px_rgba(24,42,61,0.04)]">
      <div className="flex min-w-0 items-center gap-[14px]">
        <InitialsAvatar
          initials={patient.initials}
          size={56}
          fontSize={19}
          gradient={patient.avatarGradient}
        />
        <div className="leading-[1.35]">
          <div className="flex items-center gap-[6px]">
            <h1 className="m-0 text-[17px] font-bold tracking-[-0.01em]">{patient.name}</h1>
            <SexGlyph size={13} strokeWidth={2} className="text-action" aria-hidden />
          </div>
          <div className="mt-[2px] text-[12.5px] text-muted">
            {patient.age == null ? "Age not recorded" : `${patient.age} y/o`} · {patient.sex} · {patient.dob}
          </div>
          <div className="text-[12.5px] text-muted">Patient ID: {patient.mrn}</div>
        </div>
      </div>

      <div className="h-[52px] w-px bg-hairline" aria-hidden />

      <div className="min-w-0 flex-[1.2] leading-normal">
        <div className="mb-[3px] text-[11.5px] font-semibold text-subtle">Primary Goals</div>
        <div className="text-[12.5px] text-body">{patient.primaryGoals}</div>
      </div>

      <div className="flex-1 leading-normal">
        <div className="mb-[3px] text-[11.5px] font-semibold text-subtle">Care Team</div>
        <div className="text-[12.5px] text-body">
          {patient.careTeam.map((line) => (
            <span key={line} className="block">
              {line}
            </span>
          ))}
        </div>
      </div>

      <div className="leading-normal">
        <div className="flex gap-6">
          <span>
            <span className="block text-[11.5px] font-semibold text-subtle">Last Visit</span>
            <span className="mt-[3px] block text-[12.5px] font-semibold text-ink">
              {patient.lastVisit}
            </span>
          </span>
          <span>
            <span className="block text-[11.5px] font-semibold text-subtle">Next Visit</span>
            <span className="mt-[3px] block text-[12.5px] font-semibold text-ink">
              {patient.nextVisit}
            </span>
          </span>
        </div>
      </div>

      <PatientHeaderActions patientName={patient.name} />
    </div>
  );
}
