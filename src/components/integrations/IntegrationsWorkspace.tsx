"use client";

import { useState } from "react";
import {
  ArrowDownToLine,
  ArrowLeftRight,
  ArrowUpFromLine,
  Play,
  ShieldAlert,
  Webhook as WebhookIcon,
} from "lucide-react";
import {
  AUTOMATION_ACTION_META,
  CONNECTION_STATUS_META,
  CONNECTIONS,
  setAutomationEnabled,
  setWebhookActive,
  SYNC_LOG,
  testAutomation,
  useAutomations,
  useWebhookEndpoints,
  WEBHOOK_DELIVERIES,
  type AutomationRecipe,
  type Connection,
} from "@/adapters/integrations.mock";
import { useFeedback } from "@/lib/feedback";
import { cn } from "@/lib/cn";
import { Card } from "@/components/ui/bits";
import { Btn, BtnLink } from "@/components/ui/Btn";
import { Drawer } from "@/components/ui/Drawer";
import { PageHeader } from "@/components/ui/PageHeader";
import { Pill, Tag } from "@/components/ui/Pill";
import { SegTabs } from "@/components/ui/SegTabs";
import { TableWrap, TD, TH } from "@/components/ui/Table";
import { DemoNote } from "@/components/ui/DemoNote";

const DIR_ICON = {
  import: <ArrowDownToLine size={12} aria-hidden />,
  export: <ArrowUpFromLine size={12} aria-hidden />,
  "two-way": <ArrowLeftRight size={12} aria-hidden />,
};

/* -------------------------------------------------------------- connections */

function Connections() {
  const [open, setOpen] = useState<Connection | null>(null);
  const { announce } = useFeedback();
  return (
    <>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {CONNECTIONS.map((c) => {
          const meta = CONNECTION_STATUS_META[c.status];
          return (
            <button
              key={c.id}
              onClick={() => setOpen(c)}
              className="cursor-pointer rounded-lg border border-line bg-card px-4 py-3 text-left hover:border-line-hover focus-visible:outline-2 focus-visible:outline-action"
            >
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-[13px] font-bold text-ink">{c.name}</span>
                <Pill tone={meta.tone}>{meta.label}</Pill>
              </div>
              <p className="m-0 mt-[2px] text-[11px] text-faint">{c.category} · {DIR_ICON[c.direction]} {c.direction}</p>
              <p className="m-0 mt-1 line-clamp-2 text-[12px] leading-[1.45] text-body">{c.blurb}</p>
              <p className="m-0 mt-1 text-[11px] text-subtle">Last sync: {c.lastSyncLabel}</p>
            </button>
          );
        })}
      </div>
      <DemoNote className="mt-4">
        Demo connector states — nothing here is a real connection. Sandbox means simulated
        behavior against synthetic data; connecting a real service is an operator action with
        its own security review.
      </DemoNote>

      <Drawer open={open != null} onClose={() => setOpen(null)} title={open?.name ?? ""} sub={open ? `${open.category} · ${open.environment === "sandbox" ? "Sandbox (simulated)" : "No environment"}` : undefined} labelledBy="connector-title">
        {open && (
          <div className="flex flex-col gap-3 p-5">
            <Pill tone={CONNECTION_STATUS_META[open.status].tone} className="self-start">
              {CONNECTION_STATUS_META[open.status].label}
            </Pill>
            {open.statusDetail && (
              <p className="m-0 rounded-lg bg-warning-tint px-3 py-[8px] text-[12px] leading-[1.5] text-warning-deep">
                {open.statusDetail}
              </p>
            )}
            <p className="m-0 text-[12.5px] leading-[1.55] text-body">{open.blurb}</p>
            <div>
              <p className="m-0 mb-1 text-[11px] font-bold tracking-[0.05em] text-faint uppercase">Capabilities</p>
              <ul className="m-0 flex list-none flex-col gap-1 p-0">
                {open.capabilities.map((cap) => (
                  <li key={cap} className="rounded-md border border-hairline bg-sunken px-2 py-[5px] text-[12px] text-body">{cap}</li>
                ))}
              </ul>
            </div>
            <div>
              <p className="m-0 mb-1 text-[11px] font-bold tracking-[0.05em] text-faint uppercase">Scopes & direction</p>
              <div className="flex flex-wrap gap-1">
                {open.scopes.map((s) => <Tag key={s}>{s}</Tag>)}
                <Tag>{open.direction}</Tag>
              </div>
            </div>
            <div className="flex gap-2">
              <Btn
                variant="primary"
                onClick={() => announce("Connecting a real service is an operator action — the demo never fakes a connection.")}
              >
                Connect (operator action)
              </Btn>
              <BtnLink href="/integrations?tab=sync-log">Sync log</BtnLink>
            </div>
            {open.id === "passio" && (
              <DemoNote>
                The Passio key lives server-side only — it is never present in this client
                bundle. The desktop calls a typed adapter; the adapter calls the backend.
              </DemoNote>
            )}
          </div>
        )}
      </Drawer>
    </>
  );
}

/* -------------------------------------------------------------- automations */

function AutomationCard({ recipe }: { recipe: AutomationRecipe }) {
  const { announce } = useFeedback();
  const [showRuns, setShowRuns] = useState(false);
  const hasPatientFacing = recipe.actions.some((a) => AUTOMATION_ACTION_META[a.kind].patientFacing);
  return (
    <Card className="px-4 py-3">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[13px] font-bold text-ink">{recipe.name}</span>
        {hasPatientFacing && (
          <Pill tone="warning" title="Contains a patient-facing draft action — always review-gated">
            <ShieldAlert size={11} aria-hidden /> review-gated
          </Pill>
        )}
        <label className="flex cursor-pointer items-center gap-[6px] text-[11.5px] font-semibold text-body-2">
          <input
            type="checkbox"
            checked={recipe.enabled}
            onChange={(e) => {
              setAutomationEnabled(recipe.id, e.target.checked);
              announce(`${recipe.name} ${e.target.checked ? "enabled" : "disabled"}. (demo)`);
            }}
          />
          Enabled
        </label>
      </div>

      <div className="mt-2 grid grid-cols-1 gap-2 lg:grid-cols-3">
        <div className="rounded-lg border border-hairline bg-sunken px-3 py-[7px]">
          <p className="m-0 text-[10.5px] font-bold tracking-[0.05em] text-faint uppercase">Trigger</p>
          <p className="m-0 text-[12px] text-body">{recipe.trigger}</p>
        </div>
        <div className="rounded-lg border border-hairline bg-sunken px-3 py-[7px]">
          <p className="m-0 text-[10.5px] font-bold tracking-[0.05em] text-faint uppercase">Conditions</p>
          {recipe.conditions.map((c) => (
            <p key={c} className="m-0 text-[12px] text-body">• {c}</p>
          ))}
        </div>
        <div className="rounded-lg border border-hairline bg-sunken px-3 py-[7px]">
          <p className="m-0 text-[10.5px] font-bold tracking-[0.05em] text-faint uppercase">Actions</p>
          {recipe.actions.map((a, i) => (
            <p key={i} className="m-0 text-[12px] text-body">
              • {AUTOMATION_ACTION_META[a.kind].label} — <span className="text-subtle">{a.detail}</span>
            </p>
          ))}
        </div>
      </div>

      <div className="mt-2 flex items-center gap-2">
        <Btn
          size="sm"
          variant="ai"
          onClick={() => {
            const run = testAutomation(recipe.id);
            setShowRuns(true);
            announce(`Test run ${run.outcome}. No side effects — test mode never creates or sends anything.`);
          }}
        >
          <Play size={11} aria-hidden /> Test run
        </Btn>
        <Btn size="sm" variant="ghost" onClick={() => setShowRuns((v) => !v)} aria-expanded={showRuns}>
          Run history ({recipe.runs.length})
        </Btn>
        <span className="ml-auto text-[11px] text-faint">Last run: {recipe.lastRunLabel}</span>
      </div>

      {showRuns && (
        <div className="mt-2 flex flex-col gap-1">
          {recipe.runs.length === 0 && <p className="m-0 text-[11.5px] text-faint">No runs yet.</p>}
          {recipe.runs.map((r) => (
            <div key={r.id} className="rounded-lg border border-hairline px-3 py-[7px]">
              <p className="m-0 flex items-center gap-2 text-[11.5px] font-semibold text-ink">
                {r.atLabel}
                <Tag>{r.mode}</Tag>
                <Pill tone={r.outcome === "completed" ? "positive" : r.outcome.startsWith("blocked") ? "warning" : "slate"}>{r.outcome}</Pill>
              </p>
              <ul className="m-0 mt-1 list-none p-0">
                {r.steps.map((s, i) => (
                  <li key={i} className="text-[11.5px] leading-[1.5] text-body">— {s}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function Automations() {
  const recipes = useAutomations();
  return (
    <div className="flex flex-col gap-3">
      <DemoNote>
        Hard restriction: the only patient-facing automation actions are review-gated DRAFTS and
        review-task creation. Nothing an automation does can reach a patient without a
        practitioner&apos;s explicit review — the editor cannot express such an action. Recipe
        templates live in the{" "}
        <BtnLink size="sm" href="/templates?type=automation-recipe" variant="ghost" className="inline-flex">template library</BtnLink>.
      </DemoNote>
      {recipes.map((r) => (
        <AutomationCard key={r.id} recipe={r} />
      ))}
    </div>
  );
}

/* ----------------------------------------------------------------- webhooks */

function Webhooks() {
  const endpoints = useWebhookEndpoints();
  const { announce } = useFeedback();
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {endpoints.map((w) => (
          <Card key={w.id} className="px-4 py-3">
            <div className="flex items-center gap-2">
              <WebhookIcon size={14} className="text-action" aria-hidden />
              <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold text-ink">{w.url}</span>
              <label className="flex cursor-pointer items-center gap-[6px] text-[11.5px] font-semibold text-body-2">
                <input
                  type="checkbox"
                  checked={w.active}
                  onChange={(e) => {
                    setWebhookActive(w.id, e.target.checked);
                    announce(`Endpoint ${e.target.checked ? "activated" : "paused"}. (demo)`);
                  }}
                />
                Active
              </label>
            </div>
            <div className="mt-1 flex flex-wrap gap-1">
              {w.events.map((ev) => <Tag key={ev}>{ev}</Tag>)}
              <Pill tone={w.secretSet ? "positive" : "warning"}>{w.secretSet ? "Signing secret set" : "No signing secret"}</Pill>
            </div>
          </Card>
        ))}
      </div>
      <TableWrap>
        <thead>
          <tr><TH>Delivery</TH><TH>Event</TH><TH>Endpoint</TH><TH>Attempts</TH><TH>Status</TH></tr>
        </thead>
        <tbody>
          {WEBHOOK_DELIVERIES.map((d) => (
            <tr key={d.id}>
              <TD>{d.atLabel}</TD>
              <TD className="font-medium text-ink">{d.event}</TD>
              <TD className="max-w-[280px] truncate text-subtle">{endpoints.find((e) => e.id === d.endpointId)?.url}</TD>
              <TD className="tabular-nums">{d.attempts}</TD>
              <TD><Pill tone={d.status.startsWith("delivered") ? "positive" : "critical"}>{d.status}</Pill></TD>
            </tr>
          ))}
        </tbody>
      </TableWrap>
      <DemoNote>
        Example endpoints use the reserved <code>example.invalid</code> domain; deliveries are
        simulated. No real HTTP request leaves the demo.
      </DemoNote>
    </div>
  );
}

/* ----------------------------------------------------------------- sync log */

function SyncLog() {
  return (
    <div className="flex flex-col gap-3">
      <TableWrap>
        <thead>
          <tr><TH>When</TH><TH>Connector</TH><TH>Direction</TH><TH>Summary</TH><TH>Counts</TH><TH>Status</TH></tr>
        </thead>
        <tbody>
          {SYNC_LOG.map((s) => (
            <tr key={s.id} className={cn(s.status === "failed" && "bg-[rgba(251,237,236,0.4)]")}>
              <TD className="whitespace-nowrap">{s.atLabel}</TD>
              <TD className="font-medium text-ink">{s.connector}</TD>
              <TD>{s.direction}</TD>
              <TD>{s.summary}</TD>
              <TD className="text-subtle">{s.counts}</TD>
              <TD><Pill tone={s.status === "ok" ? "positive" : "critical"}>{s.status}</Pill></TD>
            </tr>
          ))}
        </tbody>
      </TableWrap>
      <DemoNote>Simulated sync history. Failures here surface on Today as &quot;failed syncs&quot;.</DemoNote>
    </div>
  );
}

/* -------------------------------------------------------------------- shell */

const TABS = [
  { id: "connections", label: "Connections" },
  { id: "automations", label: "Automations" },
  { id: "webhooks", label: "Webhooks" },
  { id: "sync-log", label: "Sync Log" },
];

export function IntegrationsWorkspace({ tab }: { tab: string }) {
  const active = TABS.some((t) => t.id === tab) ? tab : "connections";
  return (
    <section data-screen-label="Integrations" className="mx-auto max-w-[1560px] px-[22px] pt-[18px] pb-6">
      <PageHeader
        crumb="System / Integrations"
        title="Integrations"
        sub="Connections, automations, webhooks, and the sync log. Demo states only — no real service is connected, and the UI never fakes one."
      />
      <SegTabs basePath="/integrations" value={active} ariaLabel="Integration sections" options={TABS} />
      {active === "connections" && <Connections />}
      {active === "automations" && <Automations />}
      {active === "webhooks" && <Webhooks />}
      {active === "sync-log" && <SyncLog />}
    </section>
  );
}
