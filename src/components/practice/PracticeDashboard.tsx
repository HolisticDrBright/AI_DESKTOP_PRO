import Link from "next/link";
import { ArrowRight, ChevronRight } from "lucide-react";
import type {
  PracticeDashboardData,
  Priority,
  QueueItemType,
} from "@/adapters/types";
import { practiceStatIcons } from "@/components/icons";
import { Card, CardLink, InitialsAvatar, ProgressBar } from "@/components/ui/bits";
import { toneColor, toneTint } from "@/lib/tones";

const TYPE_CHIP: Record<QueueItemType, { color: string; tint: string }> = {
  "Safety alert": { color: "#D6544A", tint: "#FBEDEC" },
  "Lab extraction": { color: "#3D5A80", tint: "#E8EEF5" },
  "Reasoning update": { color: "#5D4BB5", tint: "rgba(116,97,201,0.12)" },
  "Protocol approval": { color: "#2563C7", tint: "rgba(37,99,199,0.12)" },
  "Experiment approval": { color: "#0E8388", tint: "rgba(14,131,136,0.12)" },
};

const PRIORITY_PILL: Record<Priority, { color: string; tint: string }> = {
  High: { color: "#D6544A", tint: "#FBEDEC" },
  Medium: { color: "#C77E14", tint: "#FBF3E4" },
  Low: { color: "#5C6F82", tint: "#EEF2F6" },
};

/** Dashboard queue type → review-queue category filter. */
const TYPE_TO_FILTER: Record<QueueItemType, string> = {
  "Safety alert": "safety-alert",
  "Lab extraction": "extraction-review",
  "Reasoning update": "reasoning-review",
  "Protocol approval": "protocol-approval",
  "Experiment approval": "experiment-approval",
};

export function PracticeDashboard({ data }: { data: PracticeDashboardData }) {
  return (
    <section
      data-screen-label="Practice Dashboard"
      className="relative max-w-[1480px] px-6 pt-[22px] pb-4"
    >
      <div className="mb-[18px] flex items-end justify-between">
        <div>
          <h1 className="m-0 text-[20px] font-bold tracking-[-0.015em]">
            Practice dashboard
          </h1>
          <div className="mt-[3px] text-[13px] text-muted">{data.dateLine}</div>
        </div>
        <div className="flex items-center gap-3">
          <Link
            href="/clients"
            className="text-[12px] font-semibold text-action hover:text-action-deep focus-visible:outline-2 focus-visible:outline-action"
          >
            Client directory →
          </Link>
          <div className="flex items-center gap-[6px] text-[12px] text-subtle">
            <span className="h-[7px] w-[7px] rounded-full bg-positive-bright" aria-hidden />
            {data.statusLine}
          </div>
        </div>
      </div>

      <div className="mb-5 grid grid-cols-6 gap-3">
        {data.stats.map((stat) => {
          const Icon = practiceStatIcons[stat.icon];
          return (
            <Link
              key={stat.label}
              href={stat.href}
              className="flex cursor-pointer flex-col gap-2 rounded-[14px] border border-line bg-card p-[14px] text-left hover:border-line-hover hover:shadow-[0_3px_10px_rgba(24,42,61,0.06)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-action"
            >
              <span className="flex w-full items-center justify-between">
                <span className="text-[12px] font-semibold text-muted">{stat.label}</span>
                <span
                  className="flex h-[26px] w-[26px] items-center justify-center rounded-lg"
                  style={{ background: toneTint[stat.tone] }}
                >
                  <Icon
                    size={13}
                    strokeWidth={1.75}
                    style={{ color: toneColor[stat.tone] }}
                    aria-hidden
                  />
                </span>
              </span>
              <span className="flex items-baseline gap-[7px]">
                <span className="text-[24px] font-bold tracking-[-0.02em] text-ink">
                  {stat.value}
                </span>
                <span
                  className="text-[11.5px] font-semibold"
                  style={{ color: toneColor[stat.subTone] }}
                >
                  {stat.sub}
                </span>
              </span>
            </Link>
          );
        })}
      </div>

      <div className="grid grid-cols-[1fr_332px] items-start gap-4">
        <div className="flex flex-col gap-4">
          <ReviewQueueCard data={data} />
          <div className="grid grid-cols-2 gap-4">
            <AbnormalCard data={data} />
            <ExperimentsDoneCard data={data} />
          </div>
        </div>
        <div className="flex flex-col gap-4">
          <RiskChangesCard data={data} />
          <LowAdherenceCard data={data} />
          <TeamWorkloadCard data={data} />
        </div>
      </div>
    </section>
  );
}

function ReviewQueueCard({ data }: { data: PracticeDashboardData }) {
  return (
    <Card>
      <div className="flex items-center justify-between border-b border-hairline px-[18px] py-[14px]">
        <h2 className="m-0 text-[14px] font-bold">Review queue</h2>
        <CardLink href="/tasks" className="text-[12.5px]">
          Open queue ({data.queueOpenCount})
        </CardLink>
      </div>
      <div>
        {data.queue.map((item) => {
          const chip = TYPE_CHIP[item.type];
          const pill = PRIORITY_PILL[item.priority];
          return (
            <Link
              key={item.title}
              href={`/tasks?filter=${TYPE_TO_FILTER[item.type]}`}
              className="flex w-full cursor-pointer items-center gap-3 border-b border-[#F3F7FA] px-[18px] py-[11px] text-left hover:bg-sunken focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-action"
            >
              <span
                className="rounded-md px-2 py-[3px] text-[11px] font-semibold whitespace-nowrap"
                style={{ color: chip.color, background: chip.tint }}
              >
                {item.type}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block overflow-hidden text-[13px] font-semibold text-ellipsis whitespace-nowrap text-ink">
                  {item.title}
                </span>
                <span className="mt-px block text-[11.5px] text-subtle">
                  {item.patient} · {item.when}
                </span>
              </span>
              <span
                className="rounded-full px-[9px] py-[2px] text-[11px] font-semibold"
                style={{ color: pill.color, background: pill.tint }}
              >
                {item.priority}
              </span>
              <ChevronRight size={14} strokeWidth={2} className="text-ghost" aria-hidden />
            </Link>
          );
        })}
      </div>
    </Card>
  );
}

function AbnormalCard({ data }: { data: PracticeDashboardData }) {
  return (
    <Card>
      <div className="flex items-center justify-between border-b border-hairline px-4 py-[14px]">
        <h2 className="m-0 text-[14px] font-bold">New abnormal biomarkers</h2>
        <CardLink href="/patients/p-78435/labs" className="text-[12.5px]">
          All labs
        </CardLink>
      </div>
      <div className="py-1">
        {data.abnormal.map((row) => (
          <div
            key={`${row.marker}-${row.patient}`}
            className="flex items-center gap-[10px] border-b border-[#F5F8FA] px-4 py-[9px]"
          >
            <span
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ background: toneColor[row.tone] }}
              aria-hidden
            />
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] font-semibold">
                {row.marker}{" "}
                <span className="font-bold" style={{ color: toneColor[row.tone] }}>
                  {row.value}
                </span>
              </span>
              <span className="block text-[11.5px] text-subtle">
                {row.patient} · lab range {row.range}
              </span>
            </span>
            <span className="text-[11px] whitespace-nowrap text-faint">{row.when}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}

function ExperimentsDoneCard({ data }: { data: PracticeDashboardData }) {
  return (
    <Card>
      <div className="flex items-center justify-between border-b border-hairline px-4 py-[14px]">
        <h2 className="m-0 text-[14px] font-bold">Experiments completed</h2>
        <CardLink href="/patients/p-78435/nof1-lab" className="text-[12.5px]">
          N-of-1 Lab
        </CardLink>
      </div>
      <div className="py-1">
        {data.experimentsDone.map((exp) => (
          <div key={exp.name} className="border-b border-[#F5F8FA] px-4 py-[10px]">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[13px] font-semibold">{exp.name}</span>
              <span
                className="rounded-full px-[9px] py-[2px] text-[11px] font-semibold whitespace-nowrap"
                style={{
                  color: toneColor[exp.tone],
                  background: toneTint[exp.tone],
                }}
              >
                {exp.conclusion}
              </span>
            </div>
            <div className="mt-[2px] text-[11.5px] text-subtle">
              {exp.patient} · {exp.outcome}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

function RiskChangesCard({ data }: { data: PracticeDashboardData }) {
  return (
    <Card>
      <div className="border-b border-hairline px-4 py-[13px]">
        <h2 className="m-0 text-[14px] font-bold">Risk changes this week</h2>
      </div>
      <div className="py-1">
        {data.riskChanges.map((risk) => (
          <Link
            key={risk.name}
            href={risk.href}
            className="flex w-full cursor-pointer items-center gap-[10px] border-b border-[#F5F8FA] px-4 py-[9px] text-left hover:bg-sunken focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-action"
          >
            <InitialsAvatar
              initials={risk.initials}
              size={28}
              fontSize={10.5}
              color={risk.avatarColor}
            />
            <span className="flex-1 text-[12.5px] font-semibold text-ink">{risk.name}</span>
            <span className="flex items-center gap-[5px] text-[11px] font-semibold">
              <span style={{ color: toneColor[risk.fromTone] }}>{risk.from}</span>
              <ArrowRight size={11} strokeWidth={2} className="text-faint" aria-hidden />
              <span style={{ color: toneColor[risk.toTone] }}>{risk.to}</span>
            </span>
          </Link>
        ))}
      </div>
    </Card>
  );
}

function LowAdherenceCard({ data }: { data: PracticeDashboardData }) {
  return (
    <Card>
      <div className="border-b border-hairline px-4 py-[13px]">
        <h2 className="m-0 text-[14px] font-bold">Low adherence</h2>
      </div>
      <div className="pt-1 pb-2">
        {data.lowAdherence.map((row) => (
          <div key={row.name} className="px-4 py-2">
            <div className="mb-[5px] flex justify-between text-[12.5px]">
              <span className="font-semibold">{row.name}</span>
              <span className="font-bold" style={{ color: toneColor[row.tone] }}>
                {row.pct}%
              </span>
            </div>
            <ProgressBar
              pct={row.pct}
              color={toneColor[row.tone]}
              label={`${row.name} adherence ${row.pct} percent`}
            />
            <div className="mt-1 text-[11px] text-subtle">{row.detail}</div>
          </div>
        ))}
      </div>
    </Card>
  );
}

function TeamWorkloadCard({ data }: { data: PracticeDashboardData }) {
  return (
    <Card>
      <div className="border-b border-hairline px-4 py-[13px]">
        <h2 className="m-0 text-[14px] font-bold">Team workload</h2>
      </div>
      <div className="pt-[6px] pb-[10px]">
        {data.teamWorkload.map((member) => (
          <div key={member.name} className="flex items-center gap-[10px] px-4 py-[7px]">
            <InitialsAvatar
              initials={member.initials}
              size={26}
              fontSize={10}
              color={member.color}
            />
            <span className="w-[88px] text-[12px] font-semibold">{member.name}</span>
            <ProgressBar
              pct={member.pct}
              color="#2563C7"
              className="flex-1"
              label={`${member.name} workload ${member.pct} percent`}
            />
            <span className="w-14 text-right text-[11.5px] text-muted">
              {member.open} open
            </span>
          </div>
        ))}
      </div>
    </Card>
  );
}
