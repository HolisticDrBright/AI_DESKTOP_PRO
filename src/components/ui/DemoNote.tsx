import { Info } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * Honest-boundary note for demo/session surfaces. Used wherever a screen
 * could otherwise imply persistence, a real send, or a real connection.
 */
export function DemoNote({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p
      className={cn(
        "m-0 flex items-start gap-[7px] rounded-lg border border-line bg-sunken px-3 py-[8px] text-[11.5px] leading-[1.5] text-muted",
        className,
      )}
    >
      <Info size={13} strokeWidth={2} className="mt-[2px] shrink-0 text-faint" aria-hidden />
      <span>{children}</span>
    </p>
  );
}
