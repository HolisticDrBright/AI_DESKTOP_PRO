import { Mars, Venus } from "lucide-react";
import type { PatientDirectoryEntry } from "@/adapters/types";
import { InitialsAvatar } from "@/components/ui/bits";

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
            {patient.age} y/o · {patient.sex} · {patient.dob}
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

      <div className="flex items-center gap-2">
        <button className="h-9 cursor-pointer rounded-[9px] border-none bg-action px-4 text-[12.5px] font-semibold text-white hover:bg-action-deep focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink">
          New Appointment
        </button>
        <button
          aria-label="More actions"
          className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-[9px] border border-line bg-card pb-[7px] text-[16px] font-bold tracking-[1px] text-muted hover:border-line-hover focus-visible:outline-2 focus-visible:outline-action"
        >
          …
        </button>
      </div>
    </div>
  );
}
