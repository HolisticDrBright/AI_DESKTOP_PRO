import type { Metadata } from "next";
import { NoteTemplateWorkspace } from "@/components/encounter/NoteTemplateWorkspace";

export const metadata: Metadata = { title: "Templates — AI Longevity Pro" };

/**
 * Templates: the note layouts the scribe drafts into, and the house style it writes in.
 *
 * Only note layouts are live. Intake forms have their own surface; protocol and handout
 * templates still have no backend, and this page says so rather than implying it covers them.
 */
export default function TemplatesPage() {
  return (
    <section data-screen-label="Templates" className="mx-auto max-w-[900px] px-6 pt-[22px] pb-6">
      <h1 className="text-lg font-semibold">Note layouts</h1>
      <p className="mt-1 text-sm">
        These are the layouts a recorded visit is drafted into, and how those drafts read. Intake and consent forms
        are set up under pre-visit forms. Protocol and handout templates still have no live backend.
      </p>
      <div className="mt-4"><NoteTemplateWorkspace /></div>
    </section>
  );
}
