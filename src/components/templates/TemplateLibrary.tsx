"use client";

import Link from "next/link";
import { useState } from "react";
import { History, Search } from "lucide-react";
import {
  publishTemplate,
  TEMPLATE_KIND_LABEL,
  updateTemplate,
  useTemplates,
  type TemplateKind,
} from "@/adapters/templates.mock";
import { useFeedback } from "@/lib/feedback";
import { cn } from "@/lib/cn";
import { Btn } from "@/components/ui/Btn";
import { Drawer } from "@/components/ui/Drawer";
import { Field, TextArea, TextInput } from "@/components/ui/Field";
import { PageHeader } from "@/components/ui/PageHeader";
import { Pill, Tag } from "@/components/ui/Pill";
import { TableWrap, TD, TH } from "@/components/ui/Table";
import { DemoNote } from "@/components/ui/DemoNote";

const KINDS = Object.keys(TEMPLATE_KIND_LABEL) as TemplateKind[];

/**
 * Contextual, versioned template library. Not in primary navigation —
 * composers, Care Plan, Programs, Inbox, Billing, and Automations link here
 * with a `?type=` filter. Editing bumps a version; publishing is audited.
 */
export function TemplateLibrary({ initialType }: { initialType?: string }) {
  const { announce } = useFeedback();
  const templates = useTemplates();
  const [kind, setKind] = useState<"all" | TemplateKind>(
    KINDS.includes(initialType as TemplateKind) ? (initialType as TemplateKind) : "all",
  );
  const [q, setQ] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const open = templates.find((t) => t.id === openId) ?? null;
  const [body, setBody] = useState("");
  const [note, setNote] = useState("");

  const visible = templates.filter((t) => {
    if (kind !== "all" && t.kind !== kind) return false;
    if (q && !`${t.name} ${t.summary}`.toLowerCase().includes(q.toLowerCase())) return false;
    return true;
  });

  return (
    <section data-screen-label="Template library" className="mx-auto max-w-[1180px] px-6 pt-[18px] pb-8">
      <PageHeader
        crumb="Library"
        title="Template library"
        sub="Versioned practice templates, opened contextually from composers, Care Plan, Programs, Inbox, Billing, and Automations — not a sidebar destination."
      />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search size={13} className="absolute top-1/2 left-[9px] -translate-y-1/2 text-faint" aria-hidden />
          <TextInput value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search templates…" aria-label="Search templates" className="w-[220px] pl-[28px]" />
        </div>
        <button
          onClick={() => setKind("all")}
          aria-pressed={kind === "all"}
          className={cn(
            "h-7 cursor-pointer rounded-full border px-[10px] text-[11.5px] font-semibold focus-visible:outline-2 focus-visible:outline-action",
            kind === "all" ? "border-nav-active-line bg-nav-active text-action-deep" : "border-line bg-card text-muted hover:border-line-hover",
          )}
        >
          All ({templates.length})
        </button>
        {KINDS.map((k) => (
          <button
            key={k}
            onClick={() => setKind(k)}
            aria-pressed={kind === k}
            className={cn(
              "h-7 cursor-pointer rounded-full border px-[10px] text-[11.5px] font-semibold focus-visible:outline-2 focus-visible:outline-action",
              kind === k ? "border-nav-active-line bg-nav-active text-action-deep" : "border-line bg-card text-muted hover:border-line-hover",
            )}
          >
            {TEMPLATE_KIND_LABEL[k]}
          </button>
        ))}
      </div>

      <TableWrap>
        <thead>
          <tr>
            <TH>Template</TH><TH>Kind</TH><TH>Version</TH><TH>Updated</TH><TH>Status</TH><TH>Used in</TH>
          </tr>
        </thead>
        <tbody>
          {visible.map((t) => (
            <tr key={t.id} className="cursor-pointer hover:bg-sunken" onClick={() => { setOpenId(t.id); setBody(t.body); setNote(""); }}>
              <TD className="font-medium text-ink">
                <button className="cursor-pointer text-left font-medium text-ink hover:text-action focus-visible:outline-2 focus-visible:outline-action">
                  {t.name}
                </button>
                <span className="block text-[11px] font-normal text-subtle">{t.summary}</span>
              </TD>
              <TD><Tag>{TEMPLATE_KIND_LABEL[t.kind]}</Tag></TD>
              <TD className="tabular-nums">v{t.history[0]?.version ?? 1}</TD>
              <TD>{t.updatedLabel}</TD>
              <TD><Pill tone={t.status === "published" ? "positive" : "slate"}>{t.status}</Pill></TD>
              <TD>
                {t.usedIn.map((u) => (
                  <Link key={u.href} href={u.href} onClick={(e) => e.stopPropagation()} className="mr-2 text-[11.5px] font-semibold text-action hover:text-action-deep">
                    {u.label}
                  </Link>
                ))}
              </TD>
            </tr>
          ))}
          {visible.length === 0 && (
            <tr><TD colSpan={6} className="py-6 text-center text-faint">No templates match.</TD></tr>
          )}
        </tbody>
      </TableWrap>

      <DemoNote className="mt-3">
        Session-versioned demo library. Assessment templates here are what gets assigned in
        Tracking → Assessments; automation recipes power Integrations → Automations.
      </DemoNote>

      <Drawer
        open={open != null}
        onClose={() => setOpenId(null)}
        width={520}
        title={open?.name ?? ""}
        sub={open ? `${TEMPLATE_KIND_LABEL[open.kind]} · by ${open.author}` : undefined}
        labelledBy="template-title"
      >
        {open && (
          <div className="flex flex-col gap-3 p-5">
            <div className="flex items-center gap-2">
              <Pill tone={open.status === "published" ? "positive" : "slate"}>{open.status}</Pill>
              <Tag>v{open.history[0]?.version ?? 1}</Tag>
              {open.status === "draft" && (
                <Btn
                  size="sm"
                  className="ml-auto"
                  onClick={() => announce(publishTemplate(open.id).message)}
                >
                  Publish to library
                </Btn>
              )}
            </div>
            <Field label="Template body">
              <TextArea value={body} onChange={(e) => setBody(e.target.value)} rows={8} />
            </Field>
            <Field label="Version note">
              <TextInput value={note} onChange={(e) => setNote(e.target.value)} placeholder="What changed?" />
            </Field>
            <Btn
              variant="primary"
              disabled={body === open.body || !note.trim()}
              onClick={() => {
                const r = updateTemplate(open.id, { body }, note.trim());
                announce(r.message);
                setNote("");
              }}
            >
              Save as new version
            </Btn>
            <div>
              <p className="m-0 mb-1 flex items-center gap-1 text-[11px] font-bold tracking-[0.05em] text-faint uppercase">
                <History size={11} aria-hidden /> Version history
              </p>
              {open.history.map((v) => (
                <p key={v.version} className="m-0 border-b border-hairline py-[6px] text-[12px] text-body last:border-b-0">
                  <span className="font-semibold">v{v.version}</span> · {v.atLabel} · {v.author} — <span className="text-subtle">{v.note}</span>
                </p>
              ))}
            </div>
          </div>
        )}
      </Drawer>
    </section>
  );
}
