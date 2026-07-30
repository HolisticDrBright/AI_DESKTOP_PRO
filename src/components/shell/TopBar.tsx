"use client";

import Link from "next/link";
import { Bell, ChevronDown, MessageCircle, Search, Sparkles, UserRound } from "lucide-react";
import { useShellUi } from "@/lib/providers";
import { Popover, PopoverHeader } from "@/components/ui/Popover";

/**
 * Top bar — CLINICAL.
 *
 * Nothing here is fabricated. The demo bar showed synthetic notifications
 * (with a fixture patient's name), a fake unread-message badge, and a fixture
 * practitioner identity — each of which would be a lie on real software. The
 * clinical bar keeps the designed surfaces and states them honestly:
 * notifications have no live feed yet (the review queue is the real inbox of
 * work), messaging is not configured, and the signed-in identity lives in
 * Settings, which reads the real session server-side.
 */

const menuLink =
  "flex items-center justify-between px-[13px] py-[9px] text-[12.5px] font-medium text-body-2 hover:bg-[rgba(37,99,199,0.06)] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-action";

const menuNote =
  "block border-t border-hairline px-[13px] py-[8px] text-[10.5px] leading-[1.45] text-faint";

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

      {/* Notifications: no live feed yet — say so, point at the real queue. */}
      <Popover
        label="Notifications"
        trigger={({ open, toggle }) => (
          <button
            onClick={toggle}
            aria-label="Notifications"
            aria-haspopup="menu"
            aria-expanded={open}
            className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-full border border-line bg-card text-body-2 hover:border-line-hover focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-action"
          >
            <Bell size={15} strokeWidth={1.75} aria-hidden />
          </button>
        )}
      >
        {({ close }) => (
          <>
            <PopoverHeader title="Notifications" note="Not configured" />
            <Link href="/tasks" onClick={close} className={menuLink}>
              Open the review queue
              <span className="text-faint" aria-hidden>→</span>
            </Link>
            <span className={menuNote}>
              Push notifications have no live feed yet. Open work lives in the review queue, which
              is real and org-scoped.
            </span>
          </>
        )}
      </Popover>

      {/* Messages: no backend — no fake unread badge. */}
      <Popover
        label="Messages"
        trigger={({ open, toggle }) => (
          <button
            onClick={toggle}
            aria-label="Messages"
            aria-haspopup="menu"
            aria-expanded={open}
            className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-full border border-line bg-card text-body-2 hover:border-line-hover focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-action"
          >
            <MessageCircle size={15} strokeWidth={1.75} aria-hidden />
          </button>
        )}
      >
        {() => (
          <>
            <PopoverHeader title="Messages" note="Not configured" />
            <span className={menuNote}>
              Secure patient messaging has no live backend yet. No message can be sent or received
              from this build.
            </span>
          </>
        )}
      </Popover>

      {/* Account: the real identity is shown in Settings (server-read session). */}
      <Popover
        label="Account menu"
        trigger={({ open, toggle }) => (
          <button
            onClick={toggle}
            aria-label="Account menu"
            aria-haspopup="menu"
            aria-expanded={open}
            className="flex h-[42px] cursor-pointer items-center gap-[9px] rounded-full border border-line bg-card py-[3px] pr-2 pl-1 hover:border-line-hover focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-action"
          >
            <span
              aria-hidden
              className="flex h-8 w-8 items-center justify-center rounded-full bg-[linear-gradient(135deg,#2563C7,#5B8AD9)] text-white"
            >
              <UserRound size={16} strokeWidth={2} />
            </span>
            <span className="text-left leading-[1.25]">
              <span className="block text-[12.5px] font-semibold text-ink">Account</span>
              <span className="block text-[10.5px] text-subtle">Signed-in practitioner</span>
            </span>
            <ChevronDown size={13} strokeWidth={2} className="text-faint" aria-hidden />
          </button>
        )}
      >
        {({ close }) => (
          <>
            <PopoverHeader title="Account" note="Session & organization" />
            <Link href="/settings" onClick={close} className={menuLink}>Settings &amp; session</Link>
            <Link href="/audit-log" onClick={close} className={menuLink}>Audit log</Link>
            <span className={menuNote}>
              Your signed-in identity and active organization are shown in Settings, read from the
              real session.
            </span>
          </>
        )}
      </Popover>
    </header>
  );
}
