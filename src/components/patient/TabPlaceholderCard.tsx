import { Sparkles } from "lucide-react";
import { Card } from "@/components/ui/bits";

/** In-patient placeholder for tabs queued in the next design phase. */
export function TabPlaceholderCard({ label }: { label: string }) {
  return (
    <Card className="flex flex-col items-center gap-[10px] px-6 py-[70px]">
      <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-[rgba(37,99,199,0.08)]">
        <Sparkles size={20} strokeWidth={1.75} className="text-action" aria-hidden />
      </span>
      <h2 className="m-0 text-[15px] font-bold">{label} — next design phase</h2>
      <p className="m-0 max-w-[380px] text-center text-[12.5px] leading-normal text-subtle">
        This section is queued in the build plan. The Summary tab shows the
        flagship composition.
      </p>
    </Card>
  );
}
