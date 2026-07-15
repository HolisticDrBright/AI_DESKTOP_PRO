"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { api } from "@/adapters";
import type { CommandItem, Tone } from "@/adapters/types";
import { commandIcons } from "@/components/icons";
import { cn } from "@/lib/cn";
import { useShellUi } from "@/lib/providers";
import { parsePatientPath } from "@/lib/routes";

/* Exact tile tints from the handoff (initials tiles run slightly stronger). */
const INITIALS_TILE: Partial<Record<Tone, { bg: string; color: string }>> = {
  teal: { bg: "rgba(14,131,136,0.14)", color: "#0E8388" },
  action: { bg: "rgba(37,99,199,0.12)", color: "#2563C7" },
  critical: { bg: "#FBEDEC", color: "#D6544A" },
};
const ICON_TILE: Partial<Record<Tone, { bg: string; color: string }>> = {
  action: { bg: "rgba(37,99,199,0.1)", color: "#2563C7" },
  ai: { bg: "rgba(116,97,201,0.1)", color: "#7461C9" },
  slate: { bg: "#EEF2F6", color: "#5C6F82" },
};

export function CommandPalette() {
  const { cmdOpen, closeCmd, openAi } = useShellUi();
  const router = useRouter();
  const pathname = usePathname();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);

  const patientId = parsePatientPath(pathname)?.patientId;
  const { data: groups = [] } = useQuery({
    queryKey: ["commands", patientId ?? null],
    queryFn: () => api.commands.groups(patientId),
    enabled: cmdOpen,
  });

  const visibleGroups = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return groups;
    return groups
      .map((g) => ({
        ...g,
        items: g.items.filter(
          (i) =>
            i.label.toLowerCase().includes(q) || i.sub.toLowerCase().includes(q),
        ),
      }))
      .filter((g) => g.items.length > 0);
  }, [groups, query]);

  const flatItems = useMemo(
    () => visibleGroups.flatMap((g) => g.items),
    [visibleGroups],
  );

  useEffect(() => {
    if (cmdOpen) {
      setQuery("");
      setSelected(0);
    }
  }, [cmdOpen]);

  useEffect(() => setSelected(0), [query]);

  if (!cmdOpen) return null;

  const activate = (item: CommandItem) => {
    closeCmd();
    if (item.href) router.push(item.href);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((s) => (flatItems.length ? (s + 1) % flatItems.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((s) =>
        flatItems.length ? (s - 1 + flatItems.length) % flatItems.length : 0,
      );
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = flatItems[selected];
      if (item) activate(item);
    } else if (e.key === "Tab") {
      e.preventDefault();
      closeCmd();
      openAi();
    }
  };

  let flatIndex = -1;

  return (
    <div
      onClick={closeCmd}
      className="fixed inset-0 z-[100] flex justify-center bg-[rgba(24,42,61,0.32)] pt-[110px] backdrop-blur-[3px]"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="glass-overlay animate-fade-up h-fit w-[620px] overflow-hidden rounded-2xl border border-[rgba(255,255,255,0.7)] bg-[rgba(255,255,255,0.94)] shadow-[0_24px_64px_rgba(24,42,61,0.22),inset_0_1px_0_rgba(255,255,255,0.85)] outline-1 outline-[rgba(203,214,224,0.6)]"
      >
        <div className="flex items-center gap-[10px] border-b border-hairline px-4 py-[14px]">
          <Search size={16} strokeWidth={2} className="text-faint" aria-hidden />
          <input
            ref={inputRef}
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search patients, labs, actions… or ask the assistant"
            aria-label="Command palette search"
            aria-controls="cmd-results"
            aria-activedescendant={
              flatItems[selected] ? `cmd-item-${selected}` : undefined
            }
            className="flex-1 border-none bg-transparent text-[14.5px] text-ink outline-none placeholder:text-faint"
          />
          <span className="rounded-[5px] border border-line px-[6px] py-px text-[10.5px] font-semibold text-faint">
            esc
          </span>
        </div>

        <div
          id="cmd-results"
          role="listbox"
          aria-label="Command results"
          className="max-h-[380px] overflow-y-auto px-[6px] pt-[6px] pb-[10px]"
        >
          {visibleGroups.map((group) => (
            <div key={group.label}>
              <div className="px-3 pt-[10px] pb-1 text-[10.5px] font-bold tracking-[0.07em] text-faint uppercase">
                {group.label}
              </div>
              {group.items.map((item) => {
                flatIndex += 1;
                const index = flatIndex;
                const isSelected = index === selected;
                const tile = item.initials
                  ? INITIALS_TILE[item.tone]
                  : ICON_TILE[item.tone];
                const Icon = item.icon ? commandIcons[item.icon] : null;
                return (
                  <button
                    key={item.label}
                    id={`cmd-item-${index}`}
                    role="option"
                    aria-selected={isSelected}
                    onClick={() => activate(item)}
                    onMouseMove={() => setSelected(index)}
                    className={cn(
                      "flex w-full cursor-pointer items-center gap-[11px] rounded-[9px] border-none px-3 py-[9px] text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-action",
                      isSelected ? "bg-[rgba(37,99,199,0.07)]" : "bg-transparent",
                    )}
                  >
                    <span
                      aria-hidden
                      className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-[7px] text-[10px] font-bold"
                      style={{ background: tile?.bg, color: tile?.color }}
                    >
                      {item.initials ??
                        (Icon && <Icon size={13} strokeWidth={1.75} />)}
                    </span>
                    <span className="flex-1">
                      <span className="block text-[13px] font-semibold text-ink">
                        {item.label}
                      </span>
                      <span className="block text-[11px] text-faint">{item.sub}</span>
                    </span>
                    {item.kbd && (
                      <span className="text-[10.5px] font-semibold text-faint">
                        {item.kbd}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
          {flatItems.length === 0 && (
            <div className="px-3 py-6 text-center text-[12.5px] text-faint">
              No matches for “{query}”.
            </div>
          )}
        </div>

        <div className="flex gap-4 border-t border-hairline bg-[rgba(247,250,252,0.6)] px-4 py-[9px] text-[10.5px] text-faint">
          <span>
            <b className="text-muted">↑↓</b> navigate
          </span>
          <span>
            <b className="text-muted">↵</b> open
          </span>
          <span>
            <b className="text-muted">tab</b> ask assistant
          </span>
        </div>
      </div>
    </div>
  );
}
