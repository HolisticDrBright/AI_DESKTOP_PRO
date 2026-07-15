"use client";

import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Card, CardTitle } from "@/components/ui/bits";
import { useMaterial } from "@/lib/providers";

/**
 * The one live setting in Phase 1: the surface material tweak from the
 * handoff (solid | glass) plus the atmospheric background toggle.
 */
const SCALE_LABEL = { compact: "Compact", default: "Default", large: "Large" } as const;

export function AppearanceCard() {
  const { material, setMaterial, atmosphere, setAtmosphere, scale, setScale } = useMaterial();

  return (
    <div className="mx-auto max-w-[420px] px-6 pb-16">
      <Card className="px-4 py-[14px]">
        <CardTitle className="mb-[11px]">Appearance &amp; accessibility</CardTitle>
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
          <div className="flex items-center justify-between">
            <span className="text-[12.5px] text-body">Display scale</span>
            <SegmentedControl
              options={["Compact", "Default", "Large"]}
              value={SCALE_LABEL[scale]}
              onChange={(v) =>
                setScale(v === "Compact" ? "compact" : v === "Large" ? "large" : "default")
              }
              ariaLabel="Display scale"
            />
          </div>
        </div>
        <p className="mt-[10px] mb-0 text-[11px] leading-normal text-subtle">
          Display scale adjusts information density and text size together — Compact fits more
          on screen, Large enlarges everything for readability.
        </p>
      </Card>
    </div>
  );
}
