"use client";

import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Card, CardTitle } from "@/components/ui/bits";
import { useMaterial } from "@/lib/providers";

/**
 * The one live setting in Phase 1: the surface material tweak from the
 * handoff (solid | glass) plus the atmospheric background toggle.
 */
export function AppearanceCard() {
  const { material, setMaterial, atmosphere, setAtmosphere } = useMaterial();

  return (
    <div className="mx-auto max-w-[420px] px-6 pb-16">
      <Card className="px-4 py-[14px]">
        <CardTitle className="mb-[11px]">Appearance</CardTitle>
        <div className="flex flex-col gap-[10px]">
          <div className="flex items-center justify-between">
            <span className="text-[12.5px] text-body">Surface material</span>
            <SegmentedControl
              options={["Solid", "Glass"]}
              value={material === "glass" ? "Glass" : "Solid"}
              onChange={(v) => setMaterial(v === "Glass" ? "glass" : "solid")}
              ariaLabel="Surface material"
            />
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[12.5px] text-body">Atmospheric background</span>
            <SegmentedControl
              options={["On", "Off"]}
              value={atmosphere ? "On" : "Off"}
              onChange={(v) => setAtmosphere(v === "On")}
              ariaLabel="Atmospheric background"
            />
          </div>
        </div>
        <p className="mt-[10px] mb-0 text-[11px] leading-normal text-subtle">
          Glass adds a subtle blur to the sidebar, top bar and patient header.
        </p>
      </Card>
    </div>
  );
}
