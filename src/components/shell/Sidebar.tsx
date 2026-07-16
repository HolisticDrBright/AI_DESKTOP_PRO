"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Activity,
  BarChart3,
  Calendar,
  CheckSquare,
  ChevronDown,
  CircleHelp,
  ClipboardList,
  Clock,
  CreditCard,
  FileText,
  FlaskConical,
  GitBranch,
  Home,
  Import,
  Layers,
  LayoutTemplate,
  Link as LinkIcon,
  MessageCircle,
  Pill,
  Receipt,
  ScrollText,
  ShieldCheck,
  SlidersVertical,
  Sparkles,
  TestTube,
  User,
  Users,
  UsersRound,
  Utensils,
  Watch,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { DEFAULT_PATIENT_ID } from "@/adapters";
import type { PatientTabId } from "@/adapters/types";
import { cn } from "@/lib/cn";
import { parsePatientPath, patientPath } from "@/lib/routes";

interface NavItem {
  id: string;
  label: string;
  icon: LucideIcon;
  badge?: string;
  /** Patient-scoped tab, or a standalone route. */
  target: { tab: PatientTabId } | { href: string };
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

/**
 * System-of-record navigation. Grouped so operational surfaces (billing,
 * claims, automations, audit) sit alongside clinical ones — the app presents
 * as a practice system, not a single patient view.
 */
const NAV_GROUPS: NavGroup[] = [
  {
    label: "Workspace",
    items: [
      { id: "overview", label: "Overview", icon: Home, target: { tab: "summary" } },
      { id: "clients", label: "Clients", icon: Users, target: { href: "/clients" } },
      { id: "calendar", label: "Calendar", icon: Calendar, target: { href: "/calendar" } },
      { id: "tasks", label: "Tasks", icon: CheckSquare, badge: "8", target: { href: "/tasks" } },
      { id: "messages", label: "Messages", icon: MessageCircle, badge: "3", target: { href: "/messages" } },
    ],
  },
  {
    label: "Clinical",
    items: [
      { id: "twin", label: "Health Twin", icon: Activity, target: { tab: "twin" } },
      { id: "timeline", label: "Timeline", icon: Clock, target: { tab: "timeline" } },
      { id: "labs", label: "Labs & Biomarkers", icon: FlaskConical, target: { tab: "labs" } },
      { id: "reasoning", label: "Clinical Reasoning", icon: GitBranch, target: { tab: "reasoning" } },
      { id: "protocols", label: "Protocols", icon: ClipboardList, target: { tab: "protocols" } },
      { id: "supplements", label: "Supplements", icon: Pill, target: { tab: "supplements" } },
      { id: "nof1", label: "N-of-1 Lab", icon: TestTube, target: { tab: "nof1-lab" } },
      { id: "wearables", label: "Wearables", icon: Watch, target: { href: "/wearables" } },
      { id: "assessments", label: "Assessments", icon: FileText, target: { href: "/assessments" } },
      { id: "nutrition", label: "Nutrition", icon: Utensils, target: { href: "/nutrition" } },
      { id: "quantum", label: "Quantum Mind", icon: Sparkles, target: { href: "/quantum-mind" } },
    ],
  },
  {
    label: "Operations",
    items: [
      { id: "programs", label: "Programs", icon: Layers, target: { href: "/programs" } },
      { id: "templates", label: "Templates", icon: LayoutTemplate, target: { href: "/templates" } },
      { id: "automations", label: "Automations", icon: Zap, target: { href: "/automations" } },
      { id: "imports", label: "Imports", icon: Import, target: { href: "/imports" } },
      { id: "billing", label: "Billing", icon: CreditCard, target: { href: "/billing" } },
      { id: "claims", label: "Claims", icon: Receipt, target: { href: "/claims" } },
      { id: "reports", label: "Reports", icon: BarChart3, target: { href: "/reports" } },
      { id: "integrations", label: "Integrations", icon: LinkIcon, target: { href: "/integrations" } },
      { id: "team", label: "Team", icon: UsersRound, target: { href: "/team" } },
    ],
  },
  {
    label: "System",
    items: [
      { id: "ai-safety", label: "AI Safety", icon: ShieldCheck, target: { href: "/ai-safety" } },
      { id: "audit", label: "Audit Log", icon: ScrollText, target: { href: "/audit-log" } },
      { id: "settings", label: "Settings", icon: SlidersVertical, target: { href: "/settings" } },
    ],
  },
];

/** Patient tabs that map to a sidebar item (the Reports tab lives in the tab bar). */
const TAB_TO_NAV: Partial<Record<PatientTabId, string>> = {
  summary: "overview",
  twin: "twin",
  timeline: "timeline",
  labs: "labs",
  reasoning: "reasoning",
  supplements: "supplements",
  "nof1-lab": "nof1",
  protocols: "protocols",
};

const ROUTE_TO_NAV: Record<string, string> = {
  "/clients": "clients",
  "/practice": "clients",
  "/calendar": "calendar",
  "/tasks": "tasks",
  "/messages": "messages",
  "/wearables": "wearables",
  "/assessments": "assessments",
  "/nutrition": "nutrition",
  "/quantum-mind": "quantum",
  "/programs": "programs",
  "/templates": "templates",
  "/automations": "automations",
  "/imports": "imports",
  "/billing": "billing",
  "/claims": "claims",
  "/reports": "reports",
  "/integrations": "integrations",
  "/team": "team",
  "/ai-safety": "ai-safety",
  "/audit-log": "audit",
  "/settings": "settings",
};

export function Sidebar() {
  const pathname = usePathname();
  const patient = parsePatientPath(pathname);
  const patientId = patient?.patientId ?? DEFAULT_PATIENT_ID;
  const activeId = patient ? TAB_TO_NAV[patient.tab] : (ROUTE_TO_NAV[pathname] ?? "");

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
        {NAV_GROUPS.map((group) => (
          <div key={group.label} className="flex flex-col gap-[2px]">
            <div className="px-[10px] pt-[6px] pb-[3px] text-[10px] font-bold tracking-[0.07em] text-faint uppercase">
              {group.label}
            </div>
            {group.items.map((item) => {
              const active = item.id === activeId;
              const href =
                "href" in item.target
                  ? item.target.href
                  : patientPath(patientId, item.target.tab);
              const Icon = item.icon;
              return (
                <Link
                  key={item.id}
                  href={href}
                  className={cn(
                    "flex w-full items-center gap-[11px] rounded-[9px] border px-[10px] py-2 text-left text-[13px] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-action",
                    active
                      ? "border-nav-active-line bg-nav-active font-semibold text-action-deep"
                      : "border-transparent font-medium text-body-2 hover:bg-[rgba(37,99,199,0.06)]",
                  )}
                  aria-current={active ? "page" : undefined}
                >
                  <Icon size={17} strokeWidth={1.75} className="shrink-0 opacity-90" aria-hidden />
                  <span className="flex-1">{item.label}</span>
                  {item.badge && (
                    <span className="rounded-full bg-[rgba(90,107,126,0.12)] px-[7px] py-px text-[11px] font-semibold text-muted">
                      {item.badge}
                    </span>
                  )}
                </Link>
              );
            })}
          </div>
        ))}
      </div>

      <div className="flex flex-col gap-2 border-t border-[#E9EFF5] p-3">
        <button className="flex w-full cursor-pointer items-center gap-[9px] rounded-[10px] border border-line bg-card px-[11px] py-[9px] text-left hover:border-line-hover focus-visible:outline-2 focus-visible:outline-action">
          <span className="flex h-[26px] w-[26px] items-center justify-center rounded-lg bg-[rgba(13,92,99,0.1)]">
            <User size={13} strokeWidth={1.75} className="text-brand" aria-hidden />
          </span>
          <span className="flex-1 leading-[1.25]">
            <span className="block text-[10.5px] text-subtle">Viewing as</span>
            <span className="block text-[12.5px] font-semibold text-ink">Practitioner</span>
          </span>
          <ChevronDown size={13} strokeWidth={2} className="text-faint" aria-hidden />
        </button>
        <button className="flex w-full cursor-pointer items-center gap-[9px] rounded-[10px] border border-transparent bg-transparent px-[11px] py-2 text-left text-[12.5px] font-semibold text-muted hover:bg-[rgba(37,99,199,0.06)] focus-visible:outline-2 focus-visible:outline-action">
          <CircleHelp size={14} strokeWidth={1.75} aria-hidden />
          Help Center
        </button>
      </div>
    </nav>
  );
}
