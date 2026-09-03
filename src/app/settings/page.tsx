import Link from "next/link";
import {
  Blocks,
  Building2,
  CalendarDays,
  ClipboardList,
  CreditCard,
  Database,
  Layers,
  LibraryBig,
  MessageSquare,
  PackageSearch,
  ShieldCheck,
  UsersRound,
  type LucideIcon,
  FileSearch,
} from "lucide-react";
import { AppearanceCard } from "@/components/settings/AppearanceCard";
import { DataSourceCard } from "@/components/settings/DataSourceCard";
import { OrgMembersCard } from "@/components/settings/OrgMembersCard";
import { PrivacyCard } from "@/components/settings/PrivacyCard";

const GROUPS: {
  title: string;
  note: string;
  links: { label: string; detail: string; href: string; icon: LucideIcon }[];
}[] = [
  {
    title: "Practice",
    note: "The clinic identity and day-to-day operating setup.",
    links: [
      { label: "Practice profile & branding", detail: "Identity, location, language, and display", href: "/settings#practice-preferences", icon: Building2 },
      { label: "Scheduling & online booking", detail: "Visit types, availability, wait list, and calendar", href: "/calendar", icon: CalendarDays },
      { label: "Forms & chart templates", detail: "Reusable intake, charting, and care-plan structures", href: "/templates", icon: ClipboardList },
      { label: "Clinical Knowledge Center", detail: "Versioned protocols, lab logic, products, and safety rules", href: "/settings/knowledge", icon: LibraryBig },
      { label: "Import Review", detail: "Read practitioner files, review every row, and decide what becomes governed content", href: "/settings/imports", icon: FileSearch },
    ],
  },
  {
    title: "Team & access",
    note: "People, permissions, and accountable access.",
    links: [
      { label: "Team & permissions", detail: "Staff roles, membership, and access boundaries", href: "/team", icon: UsersRound },
      { label: "Security & governance", detail: "Audit history and governed AI features", href: "/settings/governance", icon: ShieldCheck },
      { label: "Ask ALP activation", detail: "Review and sign the exact patient-chat safety configuration", href: "/settings/ask-alp", icon: MessageSquare },
    ],
  },
  {
    title: "Communications",
    note: "Patient conversations and delivery channels.",
    links: [
      { label: "Secure inbox", detail: "Patient messages, internal notes, and review", href: "/inbox", icon: MessageSquare },
      { label: "Reminders & communication connectors", detail: "Email, SMS, CRM, and appointment integrations", href: "/integrations", icon: Blocks },
    ],
  },
  {
    title: "Catalog & commerce",
    note: "What the practice sells, dispenses, and bills.",
    links: [
      { label: "Products & inventory", detail: "Suppliers, descriptions, low-stock alerts, and invoice copy", href: "/settings/catalog", icon: PackageSearch },
      { label: "Billing, payments & tax", detail: "Checkout, invoices, memberships, and reporting", href: "/billing", icon: CreditCard },
      { label: "Programs & memberships", detail: "Education products, offers, and active enrollments", href: "/programs", icon: Layers },
    ],
  },
  {
    title: "Data & integrations",
    note: "Connected systems, migration, and data boundaries.",
    links: [
      { label: "Integrations", detail: "Clinical, lab, telehealth, commerce, and CRM connectors", href: "/integrations", icon: Blocks },
      { label: "Data & imports", detail: "Import tools and source-of-record boundaries", href: "/settings/data", icon: Database },
    ],
  },
];

export default function SettingsPage() {
  return (
    <section data-screen-label="Settings" className="mx-auto max-w-[1180px] px-6 pt-[24px] pb-10">
      <div className="mb-5">
        <div className="text-[11.5px] font-semibold text-faint">System / Settings</div>
        <h1 className="m-0 mt-[2px] text-[21px] font-bold tracking-[-0.015em]">Settings</h1>
        <p className="mt-[4px] mb-0 text-[12px] leading-[1.5] text-subtle">
          A consolidated home for practice operations, team access, communications, commerce,
          and data. Frequently used work remains in the main navigation.
        </p>
      </div>

      <div className="grid grid-cols-1 border-y border-line lg:grid-cols-2">
        {GROUPS.map((group) => (
          <section key={group.title} className="border-b border-line py-4 lg:odd:border-r lg:nth-last-[-n+2]:border-b-0">
            <div className="px-4">
              <h2 className="m-0 text-[14px] font-bold text-ink">{group.title}</h2>
              <p className="mt-1 mb-3 text-[11.5px] text-subtle">{group.note}</p>
            </div>
            <div className="flex flex-col">
              {group.links.map((item) => {
                const Icon = item.icon;
                return (
                  <Link key={item.label} href={item.href} className="group flex items-center gap-3 px-4 py-[9px] hover:bg-sunken focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-action">
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-number-tint text-action"><Icon size={15} strokeWidth={1.8} aria-hidden /></span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[12.5px] font-semibold text-ink">{item.label}</span>
                      <span className="block truncate text-[11px] text-subtle">{item.detail}</span>
                    </span>
                    <span className="text-faint group-hover:text-action" aria-hidden>→</span>
                  </Link>
                );
              })}
            </div>
          </section>
        ))}
      </div>

      <div id="practice-preferences" className="mt-6">
        <AppearanceCard />
        <DataSourceCard />
        <OrgMembersCard />
        <PrivacyCard />
      </div>
    </section>
  );
}
