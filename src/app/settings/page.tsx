import Link from "next/link";
import { AppearanceCard } from "@/components/settings/AppearanceCard";
import { PrivacyCard } from "@/components/settings/PrivacyCard";

export default function SettingsPage() {
  return (
    <section data-screen-label="Settings" className="pt-[24px] pb-10">
      <div className="mx-auto mb-4 max-w-[420px] px-6">
        <div className="text-[11.5px] font-semibold text-faint">System / Settings</div>
        <h1 className="m-0 mt-[2px] text-[21px] font-bold tracking-[-0.015em]">Settings</h1>
        <p className="mt-[4px] mb-0 text-[12px] leading-[1.5] text-subtle">
          Appearance, accessibility, and the AI data-use policy surface. Roles &amp;
          permissions live under{" "}
          <Link href="/team" className="font-semibold text-action hover:text-action-deep">Operations → Team</Link>.
        </p>
      </div>
      <AppearanceCard />
      <PrivacyCard />
    </section>
  );
}
