"use client";

import { setNavMode, useNavMode } from "@/adapters/tracking.mock";
import { USE_LIVE_API } from "@/adapters/mode";
import { Card, CardTitle } from "@/components/ui/bits";
import { SegmentedControl } from "@/components/ui/SegmentedControl";

/**
 * Navigation-variant preview: practitioner OS vs single-user Biohacker mode.
 * A preview only — no billing entitlements exist, and live mode always uses
 * the practitioner navigation.
 */
export function NavModeCard() {
  const mode = useNavMode();
  if (USE_LIVE_API) return null;
  return (
    <Card className="mx-auto mt-3 max-w-[420px] px-5 py-4">
      <CardTitle>Navigation mode (preview)</CardTitle>
      <p className="mt-1 mb-3 text-[12px] leading-[1.5] text-subtle">
        Biohacker mode collapses practice operations and centers Tracking &amp; Experiments for
        a single user. Preview only — entitlements and packaging are explicitly out of scope.
      </p>
      <SegmentedControl
        ariaLabel="Navigation mode"
        options={["Practitioner", "Biohacker"]}
        value={mode === "biohacker" ? "Biohacker" : "Practitioner"}
        onChange={(v) => setNavMode(v === "Biohacker" ? "biohacker" : "practitioner")}
      />
    </Card>
  );
}
