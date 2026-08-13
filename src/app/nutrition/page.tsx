import { NutritionTemplateLibrary } from "@/components/nutrition/NutritionTemplateLibrary";

export const metadata = { title: "Diet templates" };

/**
 * The organization's diet template library.
 *
 * A patient's plan lives on their Nutrition tab; this is the shared library the
 * plans are started from.
 */
export default function NutritionTemplatesPage() {
  return (
    <div className="space-y-4 p-4">
      <div>
        <h1 className="text-lg font-semibold">Diet templates</h1>
        <p className="text-sm text-slate-badge">
          Reusable dietary patterns for this practice. A template is educational
          scaffolding — it becomes advice only once a practitioner personalises it
          into a patient&rsquo;s plan and approves it.
        </p>
      </div>
      <NutritionTemplateLibrary />
    </div>
  );
}
