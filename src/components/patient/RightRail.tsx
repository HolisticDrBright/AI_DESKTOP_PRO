import Link from "next/link";
import { Plus } from "lucide-react";
import type { Priority, RightRailData } from "@/adapters/types";
import { railAlertIcons } from "@/components/icons";
import { Card, InitialsAvatar } from "@/components/ui/bits";
import { toneColor, toneTint } from "@/lib/tones";

const PRIORITY_CHIP: Record<Priority, { color: string; tint: string }> = {
  High: { color: "#D6544A", tint: "#FBEDEC" },
  Medium: { color: "#C77E14", tint: "#FBF3E4" },
  Low: { color: "#5C6F82", tint: "#EEF2F6" },
};

const railLinkClass =
  "mt-3 block text-[12px] font-semibold text-action hover:text-action-deep focus-visible:outline-2 focus-visible:outline-action";

export function RightRail({ data }: { data: RightRailData }) {
  return (
    <aside
      aria-label="Alerts, tasks and appointments"
      className="flex flex-col gap-4 pt-[6px]"
    >
      <Card className="px-4 py-[14px]">
        <h2 className="m-0 mb-[11px] text-[13px] font-bold">Alerts &amp; Notifications</h2>
        <div className="flex flex-col gap-3">
          {data.alerts.map((alert) => {
            const Icon = railAlertIcons[alert.icon];
            return (
              <div key={alert.title} className="flex items-start gap-[10px]">
                <span
                  className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-full"
                  style={{ background: toneTint[alert.tone] }}
                >
                  <Icon
                    size={14}
                    strokeWidth={1.75}
                    style={{ color: toneColor[alert.tone] }}
                    aria-hidden
                  />
                </span>
                <span className="min-w-0">
                  <span className="block text-[12.5px] leading-[1.35] font-semibold">
                    {alert.title}
                  </span>
                  <span className="mt-px block text-[11px] text-subtle">{alert.sub}</span>
                </span>
              </div>
            );
          })}
        </div>
        <Link href="/tasks" className={railLinkClass}>
          View All Notifications
        </Link>
      </Card>

      <Card className="px-4 py-[14px]">
        <div className="mb-[11px] flex items-center justify-between">
          <h2 className="m-0 text-[13px] font-bold">Tasks</h2>
          <Link
            href="/tasks?new=1"
            className="flex h-6 cursor-pointer items-center gap-1 rounded-[7px] border-none bg-action px-[9px] text-[11px] font-semibold text-white hover:bg-action-deep focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-action"
          >
            <Plus size={10} strokeWidth={2.5} aria-hidden />
            New Task
          </Link>
        </div>
        <div className="flex flex-col gap-[11px]">
          {data.tasks.map((task) => {
            const chip = PRIORITY_CHIP[task.priority];
            return (
              <Link
                key={task.title}
                href={`/tasks?priority=${task.priority}`}
                className="-mx-[6px] flex items-start gap-[10px] rounded-lg px-[6px] py-[3px] hover:bg-sunken focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-action"
              >
                <span
                  className="mt-[2px] h-[15px] w-[15px] shrink-0 rounded-[5px] border-[1.5px] border-ghost"
                  aria-hidden
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-[12.5px] leading-[1.3] font-semibold">
                    {task.title}
                  </span>
                  <span className="mt-px block text-[11px] text-subtle">{task.who}</span>
                </span>
                <span
                  className="shrink-0 rounded-md px-2 py-[2px] text-[10px] font-semibold"
                  style={{ color: chip.color, background: chip.tint }}
                >
                  {task.priority}
                </span>
              </Link>
            );
          })}
        </div>
        <Link href="/tasks" className={railLinkClass}>
          View All Tasks ({data.openTaskCount})
        </Link>
      </Card>

      <Card className="px-4 py-[14px]">
        <h2 className="m-0 mb-[11px] text-[13px] font-bold">Upcoming Appointments</h2>
        <div className="flex flex-col gap-[11px]">
          {data.appointments.map((appt) => (
            <div key={appt.name} className="flex items-center gap-[10px]">
              <InitialsAvatar
                initials={appt.initials}
                size={30}
                fontSize={10.5}
                color={appt.color}
              />
              <span className="min-w-0">
                <span className="block text-[12.5px] font-semibold">{appt.name}</span>
                <span className="block text-[11px] text-subtle">{appt.when}</span>
              </span>
            </div>
          ))}
        </div>
        <Link href="/calendar" className={railLinkClass}>
          View Calendar
        </Link>
      </Card>
    </aside>
  );
}
