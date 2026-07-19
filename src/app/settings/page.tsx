import Link from "next/link";
import { Database, ShieldCheck } from "lucide-react";
import { USE_LIVE_API } from "@/adapters/mode";
import { AppearanceCard } from "@/components/settings/AppearanceCard";
import { DataSourceCard } from "@/components/settings/DataSourceCard";
import { NavModeCard } from "@/components/settings/NavModeCard";
import { OrgMembersCard } from "@/components/settings/OrgMembersCard";
import { PrivacyCard } from "@/components/settings/PrivacyCard";

const sectionLink =
  "mx-auto mb-3 flex w-full max-w-[420px] items-center gap-3 rounded-lg border border-line bg-card px-4 py-3 hover:border-line-hover focus-visible:outline-2 focus-visible:outline-action";

export default function SettingsPage() {
  return (
    <section data-screen-label="Settings" className="pt-[24px] pb-10">
      <div className="mx-auto mb-4 max-w-[420px] px-6">
        <div className="text-[11.5px] font-semibold text-faint">System / Settings</div>
        <h1 className="m-0 mt-[2px] text-[21px] font-bold tracking-[-0.015em]">Settings</h1>
        <p className="mt-[4px] mb-0 text-[12px] leading-[1.5] text-subtle">
          Appearance, accessibility, data boundaries, and governance. Roles &amp;
          permissions live under{" "}
          <Link href="/team" className="font-semibold text-action hover:text-action-deep">System → Team</Link>.
        </p>
      </div>

      <div className="px-6">
        <Link href="/settings/data" className={sectionLink}>
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-number-tint">
            <Database size={15} strokeWidth={1.75} className="text-action" aria-hidden />
          </span>
          <span className="flex-1">
            <span className="block text-[13px] font-semibold text-ink">Data &amp; imports</span>
            <span className="block text-[11.5px] text-subtle">Import wizard · data-source boundaries</span>
          </span>
          <span className="text-faint" aria-hidden>→</span>
        </Link>
        <Link href="/settings/governance" className={sectionLink}>
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-number-tint">
            <ShieldCheck size={15} strokeWidth={1.75} className="text-action" aria-hidden />
          </span>
          <span className="flex-1">
            <span className="block text-[13px] font-semibold text-ink">Security &amp; Governance</span>
            <span className="block text-[11.5px] text-subtle">AI governance registry · audit log</span>
          </span>
          <span className="text-faint" aria-hidden>→</span>
        </Link>
      </div>

      <AppearanceCard />
      <NavModeCard />
      <DataSourceCard />
      {USE_LIVE_API && <OrgMembersCard />}
      <PrivacyCard />
    </section>
  );
}
