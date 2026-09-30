"use client";

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { useMaterial } from "@/lib/providers";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";
import { CommandPalette } from "./CommandPalette";
import { AssistantDrawer } from "./AssistantDrawer";

const ATMOSPHERE_BG =
  "radial-gradient(1100px 560px at 72% -12%, rgba(37,99,199,0.05), transparent 65%), radial-gradient(900px 520px at 6% 108%, rgba(13,92,99,0.04), transparent 60%)";

/**
 * Paths that are not part of the practitioner application and must not be wrapped in its
 * shell. The public consult page is opened by strangers, usually on a phone: the clinic's
 * navigation is not theirs to see, and this shell is deliberately desktop-only.
 */
const PUBLIC_PATHS = ["/consult"];

export function AppShell({ children }: { children: ReactNode }) {
  const { material, atmosphere, scale } = useMaterial();
  const pathname = usePathname();

  if (PUBLIC_PATHS.some((path) => pathname === path || pathname?.startsWith(`${path}/`))) {
    return (
      <div data-material={material} data-scale={scale} className="min-h-screen bg-canvas">
        <main id="main-content" tabIndex={-1} className="mx-auto w-full max-w-[560px] px-4 py-8 focus:outline-none">
          {children}
        </main>
      </div>
    );
  }

  return (
    <div
      data-material={material}
      data-atmosphere={atmosphere ? "on" : "off"}
      data-scale={scale}
      className="flex h-screen min-w-[1280px] overflow-hidden bg-canvas"
    >
      <Sidebar />
      <div className="relative flex min-w-0 flex-1 flex-col">
        <TopBar />
        <main id="main-content" tabIndex={-1} className="relative flex-1 overflow-y-auto focus:outline-none">
          <div
            aria-hidden
            className="atmosphere-layer pointer-events-none absolute inset-0"
            style={{ background: ATMOSPHERE_BG }}
          />
          {children}
        </main>
      </div>
      <CommandPalette />
      <AssistantDrawer />
    </div>
  );
}
