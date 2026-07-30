import type { Metadata } from "next";
import { ClinicalEmpty } from "@/components/ui/ClinicalStates";

export const metadata: Metadata = { title: "Inbox — AI Longevity Pro" };

/**
 * Inbox: no live backend yet. The route (and its place in the navigation)
 * stays, and it says so honestly — it never renders the demo workspace.
 * Status: docs/clinical-runtime-migration.md.
 */
export default function InboxPage() {
  return (
    <section data-screen-label="Inbox" className="mx-auto max-w-[900px] px-6 pt-[22px] pb-6">
      <ClinicalEmpty
        title="Messaging isn't configured yet"
        message="Secure patient messaging has no live backend yet. Nothing is shown rather than synthetic threads; no message can be sent from this screen."
      />
    </section>
  );
}
