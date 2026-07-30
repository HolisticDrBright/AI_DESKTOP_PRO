import type { Metadata } from "next";
import { ClinicalEmpty } from "@/components/ui/ClinicalStates";

export const metadata: Metadata = { title: "Team — AI Longevity Pro" };

/**
 * Team: no live backend yet. The route stays in the navigation and says so
 * honestly. Status: docs/clinical-runtime-migration.md.
 */
export default function TeamPage() {
  return (
    <section data-screen-label="Team" className="mx-auto max-w-[900px] px-6 pt-[22px] pb-6">
      <ClinicalEmpty
        title="The role matrix isn't live yet"
        message="Role and permission management reads real organization memberships once its live surface exists. The database enforces access today; this screen will show it, not define it."
      />
    </section>
  );
}
