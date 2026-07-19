"use client";

import Link from "next/link";
import { useMemo } from "react";
import { usePathname } from "next/navigation";
import {
  Activity,
  BarChart3,
  Blocks,
  Calendar,
  ChevronDown,
  CircleHelp,
  ClipboardCheck,
  CreditCard,
  Inbox,
  Layers,
  SlidersVertical,
  Sun,
  User,
  Users,
  UsersRound,
  type LucideIcon,
} from "lucide-react";
import { USE_LIVE_API } from "@/adapters/mode";
import { getTaskQueue } from "@/adapters/tasks.mock";
import { useReviewOutcomes, useSessionQueueItems } from "@/adapters/session-store";
import { useUnreadThreadCount } from "@/adapters/inbox.mock";
import { useNavMode } from "@/adapters/tracking.mock";
import { DEFAULT_PATIENT_ID } from "@/adapters/patients.mock";
import { patientPath } from "@/lib/routes";
import { Popover, PopoverDemoNote, PopoverHeader } from "@/components/ui/Popover";
import { cn } from "@/lib/cn";

const footerMenuLink =
  "flex items-center justify-between px-[13px] py-[9px] text-[12.5px] font-medium text-body-2 hover:bg-[rgba(37,99,199,0.06)] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-action";

interface NavItem {
  id: string;
  label: string;
  icon: LucideIcon;
  href: string;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

/**
 * Practice-level navigation ONLY (practitioner-OS IA). Patient-scoped
 * destinations live exclusively in the patient chart's local tabs — the
 * sidebar never duplicates them. Restrained three-group structure.
 */
const NAV_GROUPS: NavGroup[] = [
  {
    label: "Workspace",
    items: [
      { id: "today", label: "Today", icon: Sun, href: "/today" },
      { id: "calendar", label: "Calendar", icon: Calendar, href: "/calendar" },
      { id: "patients", label: "Patients", icon: Users, href: "/patients" },
      { id: "review", label: "Review Queue", icon: ClipboardCheck, href: "/tasks" },
      { id: "inbox", label: "Inbox", icon: Inbox, href: "/inbox" },
    ],
  },
  {
    label: "Business",
    items: [
      { id: "programs", label: "Programs", icon: Layers, href: "/programs" },
      { id: "billing", label: "Billing", icon: CreditCard, href: "/billing" },
      { id: "reports", label: "Reports", icon: BarChart3, href: "/reports" },
    ],
  },
  {
    label: "System",
    items: [
      { id: "integrations", label: "Integrations", icon: Blocks, href: "/integrations" },
      { id: "team", label: "Team", icon: UsersRound, href: "/team" },
      { id: "settings", label: "Settings", icon: SlidersVertical, href: "/settings" },
    ],
  },
];

/**
 * Biohacker navigation variant (preview, Settings → Navigation mode): a
 * single-user shape — practice operations collapse, Tracking is central.
 * No entitlements; live mode always uses the practitioner navigation.
 */
const BIOHACKER_GROUPS: NavGroup[] = [
  {
    label: "My health",
    items: [
      { id: "today", label: "Today", icon: Sun, href: "/today" },
      { id: "patients", label: "My Data", icon: Users, href: patientPath(DEFAULT_PATIENT_ID) },
      { id: "tracking", label: "Tracking & Experiments", icon: Activity, href: `${patientPath(DEFAULT_PATIENT_ID, "tracking")}?view=twin` },
      { id: "calendar", label: "Schedule", icon: Calendar, href: "/calendar" },
    ],
  },
  {
    label: "Learning",
    items: [{ id: "programs", label: "Programs", icon: Layers, href: "/programs" }],
  },
  {
    label: "System",
    items: [
      { id: "billing", label: "Subscriptions", icon: CreditCard, href: "/billing?tab=subscriptions" },
      { id: "settings", label: "Settings", icon: SlidersVertical, href: "/settings" },
    ],
  },
];

/** Longest-prefix route → nav id (patient chart highlights Patients). */
function activeNavId(pathname: string): string {
  if (pathname === "/today") return "today";
  if (pathname.startsWith("/calendar")) return "calendar";
  if (pathname.startsWith("/patients")) return "patients";
  if (pathname.startsWith("/tasks")) return "review";
  if (pathname.startsWith("/inbox")) return "inbox";
  if (pathname.startsWith("/programs")) return "programs";
  if (pathname.startsWith("/billing")) return "billing";
  if (pathname.startsWith("/reports")) return "reports";
  if (pathname.startsWith("/integrations")) return "integrations";
  if (pathname.startsWith("/team")) return "team";
  if (pathname.startsWith("/settings")) return "settings";
  if (pathname.startsWith("/templates")) return "settings";
  return "";
}

export function Sidebar() {
  const pathname = usePathname();
  const activeId = activeNavId(pathname);
  const navMode = useNavMode();
  const groups = !USE_LIVE_API && navMode === "biohacker" ? BIOHACKER_GROUPS : NAV_GROUPS;

  // Open review-queue badge from the same stores as /tasks so it matches the
  // screen. Demo mode only — the live queue is fetched per screen, so no
  // badge there rather than a possibly-stale number.
  const sessionAdded = useSessionQueueItems();
  const reviews = useReviewOutcomes();
  const baseCount = useMemo(() => getTaskQueue().length, []);
  const resolvedCount = Object.entries(reviews).filter(
    ([key, outcome]) => key.startsWith("queue:") && outcome === "resolved",
  ).length;
  const openTasks = USE_LIVE_API
    ? 0
    : Math.max(0, baseCount + sessionAdded.length - resolvedCount);
  const unreadThreads = useUnreadThreadCount();

  const badges: Record<string, number> = {
    review: openTasks,
    inbox: USE_LIVE_API ? 0 : unreadThreads,
  };

  return (
    <nav
      aria-label="Primary navigation"
      className="glassable relative z-40 flex w-[236px] shrink-0 flex-col border-r border-line bg-[rgba(248,250,252,0.9)]"
    >
      <div className="flex gap-[7px] px-4 pt-[14px] pb-1" aria-hidden>
        <span className="h-[11px] w-[11px] rounded-full bg-mac-red" />
        <span className="h-[11px] w-[11px] rounded-full bg-mac-yellow" />
        <span className="h-[11px] w-[11px] rounded-full bg-mac-green" />
      </div>

      <div className="flex items-center gap-[10px] px-4 pt-3 pb-[14px]">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-[linear-gradient(135deg,#0D5C63,#1A7A82)] shadow-[0_2px_6px_rgba(13,92,99,0.25)]">
          <Activity size={19} strokeWidth={2} className="text-white" aria-hidden />
        </div>
        <div className="leading-[1.3]">
          <div className="text-[14px] font-bold tracking-[-0.01em]">AI Longevity Pro</div>
          <div className="text-[10.5px] text-subtle">Clinical Intelligence Platform</div>
        </div>
      </div>

      <div className="flex flex-1 flex-col gap-[10px] overflow-y-auto px-3 pt-[2px] pb-3">
        {groups.map((group) => (
          <div key={group.label} className="flex flex-col gap-[2px]">
            <div className="px-[10px] pt-[6px] pb-[3px] text-[10px] font-bold tracking-[0.07em] text-faint uppercase">
              {group.label}
            </div>
            {group.items.map((item) => {
              const active = item.id === activeId;
              const Icon = item.icon;
              const badge = badges[item.id];
              return (
                <Link
                  key={item.id}
                  href={item.href}
                  className={cn(
                    "flex w-full items-center gap-[11px] rounded-lg border px-[10px] py-2 text-left text-[13px] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-action",
                    active
                      ? "border-nav-active-line bg-nav-active font-semibold text-action-deep"
                      : "border-transparent font-medium text-body-2 hover:bg-[rgba(37,99,199,0.06)]",
                  )}
                  aria-current={active ? "page" : undefined}
                >
                  <Icon size={17} strokeWidth={1.75} className="shrink-0 opacity-90" aria-hidden />
                  <span className="flex-1">{item.label}</span>
                  {badge ? (
                    <span className="rounded-full bg-[rgba(90,107,126,0.12)] px-[7px] py-px text-[11px] font-semibold text-muted">
                      {badge}
                    </span>
                  ) : null}
                </Link>
              );
            })}
          </div>
        ))}
      </div>

      <div className="flex flex-col gap-2 border-t border-[#E9EFF5] p-3">
        <Popover
          label="Viewing role"
          side="top"
          align="left"
          panelClassName="w-[228px]"
          trigger={({ open, toggle }) => (
            <button
              onClick={toggle}
              aria-haspopup="menu"
              aria-expanded={open}
              className="flex w-full cursor-pointer items-center gap-[9px] rounded-[10px] border border-line bg-card px-[11px] py-[9px] text-left hover:border-line-hover focus-visible:outline-2 focus-visible:outline-action"
            >
              <span className="flex h-[26px] w-[26px] items-center justify-center rounded-lg bg-[rgba(13,92,99,0.1)]">
                <User size={13} strokeWidth={1.75} className="text-brand" aria-hidden />
              </span>
              <span className="flex-1 leading-[1.25]">
                <span className="block text-[10.5px] text-subtle">Viewing as</span>
                <span className="block text-[12.5px] font-semibold text-ink">Practitioner</span>
              </span>
              <ChevronDown size={13} strokeWidth={2} className="text-faint" aria-hidden />
            </button>
          )}
        >
          {({ close }) => (
            <>
              <PopoverHeader title="Viewing as Practitioner" note="Demo identity" />
              <Link href="/team" onClick={close} className={footerMenuLink}>
                See roles &amp; permissions
                <span className="text-faint" aria-hidden>→</span>
              </Link>
              <Link href="/settings" onClick={close} className={footerMenuLink}>
                Navigation mode (Biohacker preview)
                <span className="text-faint" aria-hidden>→</span>
              </Link>
              <PopoverDemoNote>
                Role switching arrives with real sign-in. Access is enforced by the backend, not
                this label.
              </PopoverDemoNote>
            </>
          )}
        </Popover>
        <Popover
          label="Help"
          side="top"
          align="left"
          panelClassName="w-[228px]"
          trigger={({ open, toggle }) => (
            <button
              onClick={toggle}
              aria-haspopup="menu"
              aria-expanded={open}
              className="flex w-full cursor-pointer items-center gap-[9px] rounded-[10px] border border-transparent bg-transparent px-[11px] py-2 text-left text-[12.5px] font-semibold text-muted hover:bg-[rgba(37,99,199,0.06)] focus-visible:outline-2 focus-visible:outline-action"
            >
              <CircleHelp size={14} strokeWidth={1.75} aria-hidden />
              Help Center
            </button>
          )}
        >
          {({ close }) => (
            <>
              <PopoverHeader title="Help" note="In-app references" />
              <Link href="/settings/governance?tab=ai" onClick={close} className={footerMenuLink}>
                AI governance registry
                <span className="text-faint" aria-hidden>→</span>
              </Link>
              <Link href="/settings/governance?tab=audit" onClick={close} className={footerMenuLink}>
                Audit log
                <span className="text-faint" aria-hidden>→</span>
              </Link>
              <Link href="/settings/data" onClick={close} className={footerMenuLink}>
                Data boundaries &amp; imports
                <span className="text-faint" aria-hidden>→</span>
              </Link>
              <PopoverDemoNote>
                Full help center ships with the product site — these are the in-app references.
              </PopoverDemoNote>
            </>
          )}
        </Popover>
      </div>
    </nav>
  );
}
