"use client";

import { useState } from "react";
import { FilePlus2, FileText, Image as ImageIcon, ScrollText, ShieldCheck } from "lucide-react";
import {
  addDemoFile,
  FILE_KIND_LABEL,
  useFiles,
  type FileKind,
} from "@/adapters/files.mock";
import { useFeedback } from "@/lib/feedback";
import { Card, CardTitle } from "@/components/ui/bits";
import { Btn } from "@/components/ui/Btn";
import { Field, Select, TextInput } from "@/components/ui/Field";
import { Pill } from "@/components/ui/Pill";
import { TableWrap, TD, TH } from "@/components/ui/Table";
import { DemoNote } from "@/components/ui/DemoNote";

const KIND_ICON: Record<FileKind, React.ReactNode> = {
  "lab-pdf": <FileText size={13} className="text-navy" aria-hidden />,
  "imported-record": <ScrollText size={13} className="text-warning-deep" aria-hidden />,
  consent: <ShieldCheck size={13} className="text-positive" aria-hidden />,
  "generated-report": <FileText size={13} className="text-action" aria-hidden />,
  image: <ImageIcon size={13} className="text-teal" aria-hidden />,
};

export function PatientFilesTab({
  patientId,
  patientName,
}: {
  patientId: string;
  patientName: string;
}) {
  const { announce } = useFeedback();
  const files = useFiles(patientId);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<FileKind>("generated-report");
  const [filter, setFilter] = useState<"all" | FileKind>("all");

  const visible = filter === "all" ? files : files.filter((f) => f.kind === filter);

  return (
    <div data-screen-label="Files" className="flex flex-col gap-4">
      <Card className="px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="flex-1">Documents ({files.length})</CardTitle>
          <Select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)} aria-label="Filter by kind" className="w-[180px]">
            <option value="all">All kinds</option>
            {(Object.keys(FILE_KIND_LABEL) as FileKind[]).map((k) => (
              <option key={k} value={k}>{FILE_KIND_LABEL[k]}</option>
            ))}
          </Select>
          <Btn variant="primary" size="sm" onClick={() => setAdding((v) => !v)}>
            <FilePlus2 size={12} aria-hidden /> Add file entry
          </Btn>
        </div>
        {adding && (
          <div className="mt-3 flex flex-wrap items-end gap-2 rounded-lg border border-line bg-sunken px-3 py-3">
            <Field label="File name" className="min-w-[220px] flex-1">
              <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. outside-records-2026.pdf" />
            </Field>
            <Field label="Kind">
              <Select value={kind} onChange={(e) => setKind(e.target.value as FileKind)}>
                {(Object.keys(FILE_KIND_LABEL) as FileKind[]).map((k) => (
                  <option key={k} value={k}>{FILE_KIND_LABEL[k]}</option>
                ))}
              </Select>
            </Field>
            <Btn
              variant="primary"
              disabled={!name.trim()}
              onClick={() => {
                const r = addDemoFile(patientId, patientName, name.trim(), kind);
                announce(r.message);
                setName("");
                setAdding(false);
              }}
            >
              Add entry
            </Btn>
            <p className="m-0 w-full text-[11px] text-faint">
              Demo upload — records metadata only; no file is read or transmitted. Live-mode lab
              PDFs upload through the audited ingestion pipeline instead.
            </p>
          </div>
        )}
      </Card>

      <TableWrap>
        <thead>
          <tr>
            <TH>File</TH>
            <TH>Kind</TH>
            <TH>Added</TH>
            <TH>Size</TH>
            <TH>Source</TH>
          </tr>
        </thead>
        <tbody>
          {visible.map((f) => (
            <tr key={f.id}>
              <TD className="font-medium text-ink">
                <span className="flex items-center gap-2">{KIND_ICON[f.kind]}{f.name}{f.sessionAdded && <Pill tone="slate">this session</Pill>}</span>
              </TD>
              <TD>{FILE_KIND_LABEL[f.kind]}</TD>
              <TD>{f.atLabel}</TD>
              <TD className="tabular-nums">{f.size}</TD>
              <TD className="text-subtle">{f.source}</TD>
            </tr>
          ))}
          {visible.length === 0 && (
            <tr>
              <TD colSpan={5} className="py-6 text-center text-faint">No files of this kind.</TD>
            </tr>
          )}
        </tbody>
      </TableWrap>

      <DemoNote>
        Lab PDFs open through the audited &quot;source PDF&quot; viewer in Labs &amp; Reasoning;
        this list is the practice-file index. All entries are synthetic.
      </DemoNote>
    </div>
  );
}
