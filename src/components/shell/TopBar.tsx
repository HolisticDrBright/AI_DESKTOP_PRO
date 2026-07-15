"use client";

import { Bell, ChevronDown, MessageCircle, Search, Sparkles } from "lucide-react";
import { useShellUi } from "@/lib/providers";

export function TopBar() {
  const { openCmd, toggleAi } = useShellUi();

  return (
    <header className="glassable relative z-30 flex h-[58px] shrink-0 items-center gap-3 border-b border-line bg-[rgba(250,252,253,0.85)] px-6">
      <button
        onClick={openCmd}
        aria-label="Search or open command palette"
        className="flex h-9 w-[400px] cursor-pointer items-center gap-[10px] rounded-full border border-line bg-card px-[14px] text-[13px] text-faint hover:border-line-hover focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-action"
      >
        <Search size={14} strokeWidth={2} aria-hidden />
        <span className="flex-1 text-left">Search patients, labs, reports, protocols…</span>
        <span className="rounded-md border border-line bg-sunken px-[6px] py-px text-[11px] font-semibold text-faint">
          ⌘K
        </span>
      </button>

      <div className="flex-1" />

      <button
        onClick={toggleAi}
        aria-label="Open clinical assistant"
        className="flex h-[34px] cursor-pointer items-center gap-[6px] rounded-full border border-[rgba(116,97,201,0.3)] bg-[rgba(116,97,201,0.07)] px-[13px] text-[12.5px] font-semibold text-ai-deep hover:bg-[rgba(116,97,201,0.13)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ai"
      >
        <Sparkles size={13} strokeWidth={1.75} aria-hidden />
        Assistant
      </button>

      <button
        aria-label="Notifications, unread"
        className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-full border border-line bg-card text-body-2 hover:border-line-hover focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-action"
      >
        <Bell size={15} strokeWidth={1.75} aria-hidden />
      </button>

      <button
        aria-label="Messages, 2 unread"
        className="relative flex h-9 w-9 cursor-pointer items-center justify-center rounded-full border border-line bg-card text-body-2 hover:border-line-hover focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-action"
      >
        <MessageCircle size={15} strokeWidth={1.75} aria-hidden />
        <span className="absolute top-[2px] right-[2px] h-2 w-2 rounded-full border-[1.5px] border-white bg-critical" />
      </button>

      <button className="flex h-[42px] cursor-pointer items-center gap-[9px] rounded-full border border-line bg-card py-[3px] pr-2 pl-1 hover:border-line-hover focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-action">
        <span
          aria-hidden
          className="flex h-8 w-8 items-center justify-center rounded-full bg-[linear-gradient(135deg,#2563C7,#5B8AD9)] text-[12px] font-bold text-white"
        >
          SM
        </span>
        <span className="text-left leading-[1.25]">
          <span className="block text-[12.5px] font-semibold text-ink">Dr. Sarah Mitchell</span>
          <span className="block text-[10.5px] text-subtle">Functional Medicine</span>
        </span>
        <ChevronDown size={13} strokeWidth={2} className="text-faint" aria-hidden />
      </button>
    </header>
  );
}
