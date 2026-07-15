"use client";

import type { ReactNode } from "react";
import { useMaterial } from "@/lib/providers";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";
import { CommandPalette } from "./CommandPalette";
import { AssistantDrawer } from "./AssistantDrawer";

const ATMOSPHERE_BG =
  "radial-gradient(1100px 560px at 72% -12%, rgba(37,99,199,0.05), transparent 65%), radial-gradient(900px 520px at 6% 108%, rgba(13,92,99,0.04), transparent 60%)";

export function AppShell({ children }: { children: ReactNode }) {
  const { material, atmosphere } = useMaterial();

  return (
    <div
      data-material={material}
      data-atmosphere={atmosphere ? "on" : "off"}
      className="flex h-screen min-w-[1280px] overflow-hidden bg-canvas"
    >
      <Sidebar />
      <div className="relative flex min-w-0 flex-1 flex-col">
        <TopBar />
        <main className="relative flex-1 overflow-y-auto">
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
