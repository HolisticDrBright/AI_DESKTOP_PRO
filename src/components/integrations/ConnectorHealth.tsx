"use client";

import { Link2, RotateCw, ScrollText } from "lucide-react";
import {
  CONNECTOR_STATUS_TONE,
  getConnectors,
} from "@/adapters/integrations.mock";
import { recordAuditEntry } from "@/adapters/session-store";
import { Card } from "@/components/ui/bits";
import { useFeedback } from "@/lib/feedback";
import { toneText, toneTint } from "@/lib/tones";

export function ConnectorHealth() {
  const { announce } = useFeedback();
  const connectors = getConnectors();

  const retry = (name: string) => {
    recordAuditEntry({
      kind: "request_data",
      subjectType: "connector",
      subjectLabel: `${name} — sync retry`,
      reviewed: true,
    });
    announce(`Retry queued for ${name}. (demo — no live connector)`);
  };

  return (
    <section data-screen-label="Integrations" className="relative mx-auto max-w-[1080px] px-6 pt-[24px] pb-10">
      <div className="mb-1 text-[11.5px] font-semibold text-faint">Operations / Integrations</div>
      <div className="mb-4">
        <div className="flex items-center gap-[7px]">
          <Link2 size={17} strokeWidth={2} className="text-brand" aria-hidden />
          <h1 className="m-0 text-[21px] font-bold tracking-[-0.015em]">Connector health</h1>
        </div>
        <p className="mt-[4px] mb-0 max-w-[660px] text-[12.5px] leading-[1.5] text-subtle">
          Status of every external connection. Errors are safe summaries — raw payloads, tokens,
          and PHI never appear here. Statuses are demo data until connectors are configured.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-4">
        {connectors.map((c) => {
          const tone = CONNECTOR_STATUS_TONE[c.status];
          return (
            <Card key={c.id} className="flex flex-col p-[14px]">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h2 className="m-0 text-[13.5px] font-bold">{c.name}</h2>
                  <p className="mt-[2px] mb-0 text-[11.5px] text-subtle">{c.purpose}</p>
                </div>
                <span
                  className="shrink-0 rounded-full px-[9px] py-[2px] text-[10.5px] font-bold"
                  style={{ color: toneText[tone], background: toneTint[tone] }}
                >
                  {c.status}
                </span>
              </div>

              <div className="mt-[9px] grid grid-cols-2 gap-x-3 gap-y-[5px] text-[11.5px]">
                <span><span className="text-faint">Last sync</span> <span className="text-body">{c.lastSync}</span></span>
                <span><span className="text-faint">Next sync</span> <span className="text-body">{c.nextSync}</span></span>
              </div>

              <div className="mt-[7px] flex flex-wrap gap-[4px]">
                {c.scopes.map((s) => (
                  <span key={s} className="rounded-[5px] bg-sunken-2 px-[6px] py-px font-mono text-[10px] text-muted">{s}</span>
                ))}
              </div>

              {c.safeError && (
                <p className="mt-[8px] mb-0 rounded-[8px] border border-[rgba(199,126,20,0.25)] bg-warning-tint px-[10px] py-[7px] text-[11px] leading-[1.45] text-warning-deep">
                  {c.safeError}
                </p>
              )}

              <div className="mt-auto flex items-center gap-2 pt-[10px]">
                <button
                  onClick={() => retry(c.name)}
                  className="flex h-7 cursor-pointer items-center gap-[5px] rounded-lg border border-line bg-card px-[10px] text-[11.5px] font-semibold text-body hover:border-line-hover focus-visible:outline-2 focus-visible:outline-action"
                >
                  <RotateCw size={11} strokeWidth={2} aria-hidden />
                  Retry sync
                </button>
                <button
                  onClick={() => announce(`${c.name} logs: sync history is recorded server-side; safe summaries only. (demo)`)}
                  className="flex h-7 cursor-pointer items-center gap-[5px] rounded-lg border border-line bg-card px-[10px] text-[11.5px] font-semibold text-body hover:border-line-hover focus-visible:outline-2 focus-visible:outline-action"
                >
                  <ScrollText size={11} strokeWidth={2} aria-hidden />
                  View logs
                </button>
              </div>
            </Card>
          );
        })}
      </div>
    </section>
  );
}
