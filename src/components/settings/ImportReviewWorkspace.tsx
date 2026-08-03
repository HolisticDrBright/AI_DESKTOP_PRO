"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ShieldAlert } from "lucide-react";
import { liveClient } from "@/adapters/live-client";
import { AdapterError } from "@/adapters/errors";
import type {
  LiveCatalogReviewQueue,
  LiveImportProvenanceHistory,
  LiveImportSourceInventory,
  LiveKnowledgeImportItem,
  LiveKnowledgeImportPreview,
  LiveParsedImportEnvelope,
} from "@/adapters/live-types";
import { Card, CardTitle } from "@/components/ui/bits";
import { Btn } from "@/components/ui/Btn";
import { TableWrap, TD, TH } from "@/components/ui/Table";
import { Field, Select, TextInput } from "@/components/ui/Field";
import { ClinicalError, ClinicalLoading, ClinicalNote } from "@/components/ui/ClinicalStates";
import { cn } from "@/lib/cn";

/**
 * The Import Review Workspace.
 *
 * THE SCREEN'S ONE JOB: make every refusal the database will raise visible
 * BEFORE the reviewer commits, with the evidence beside it. A gate the
 * reviewer only meets at commit time teaches them to click through gates.
 *
 * THREE STATES THAT ARE NEVER CONFLATED, on every panel:
 *
 *   * LOADING — we do not know yet.
 *   * EMPTY — we asked, and the answer is nothing. "No files declared" is a
 *     statement about the inventory.
 *   * FAILED — we could not ask. Nobody is in a position to say the inventory
 *     is empty, and the screen must not imply otherwise.
 *
 * PERMISSION DENIED is its own case rather than a generic failure, because
 * "you are not a knowledge editor here" and "the service is down" call for
 * completely different actions from the person reading it.
 */

/**
 * Phase 9E-A section identifiers. Nine tabs; five deliver working
 * governance surfaces, three are placeholders that state precisely
 * what remains, one ("parse") stays as the file-reading entry point.
 */
type Tab =
  | "overview"
  | "sources"
  | "parse"
  | "batches"
  | "conflicts"
  | "restricted"
  | "labels"
  | "references"
  | "commercial"
  | "provenance";

function errText(e: unknown): string {
  return e instanceof AdapterError ? e.message : "Something went wrong. Try again.";
}

function isDenied(e: unknown): boolean {
  return e instanceof AdapterError && (e.code === "forbidden" || e.code === "unauthenticated");
}

/** A failed panel. Denial is separated from failure — they are different facts. */
function PanelError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  if (isDenied(error)) {
    return (
      <Card className="px-6 py-10">
        <div className="flex flex-col items-center gap-2 text-center" role="alert">
          <ShieldAlert size={20} className="text-warning-deep" aria-hidden />
          <h2 className="m-0 text-[15px] font-bold">You do not have access to this</h2>
          <p className="m-0 max-w-[440px] text-[12.5px] leading-[1.5] text-subtle">
            Importing and reviewing clinical knowledge needs a knowledge-editor role in this
            organization. Nothing is missing and nothing is broken — this account cannot see it.
            Ask an owner or admin to change your role.
          </p>
        </div>
      </Card>
    );
  }
  return <ClinicalError message={errText(error)} onRetry={onRetry} />;
}

function Chip({ tone, children }: { tone: "warn" | "danger" | "ok" | "muted"; children: React.ReactNode }) {
  const cls = {
    warn: "border-warning/25 bg-warning-tint text-warning-deep",
    danger: "border-danger/25 bg-danger-tint text-danger",
    ok: "border-ok/25 bg-ok-tint text-ok",
    muted: "border-line bg-sunken text-subtle",
  }[tone];
  return (
    <span className={cn("inline-flex items-center rounded-full border px-2 py-[1px] text-[11px] font-semibold", cls)}>
      {children}
    </span>
  );
}

/* ------------------------------------------------------------- sources */

function SourcesPanel() {
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<unknown>(null);
  const [data, setData] = useState<LiveImportSourceInventory | null>(null);
  const [name, setName] = useState("");
  const [availability, setAvailability] = useState<"available" | "unavailable">("unavailable");
  const [reason, setReason] = useState("");
  const [digest, setDigest] = useState("");
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    setState("loading");
    try {
      setData(await liveClient.importSourceInventory());
      setState("ready");
    } catch (e) {
      setError(e);
      setState("error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const declare = async () => {
    setMessage("");
    // Refused here as well as in the database. Not duplication for its own
    // sake: the database's refusal arrives as an opaque constraint violation
    // (this boundary does not pass database messages through), so without a
    // local check the operator would be told "invalid" and left guessing. The
    // constraint remains the backstop; this is the sentence they can act on.
    const declared = name.trim();
    if (
      declared.includes("/")
      || declared.includes("\\")
      || /^[A-Za-z]:/.test(declared)
      || declared.startsWith("~")
    ) {
      setMessage(
        "Record the file by NAME, never by path. Where the practitioner keeps their "
          + "clinical material is not this system's business and must not end up in a "
          + "database that gets dumped, replicated or supported.",
      );
      return;
    }
    try {
      await liveClient.recordImportSourceFile({
        declaredName: name.trim(),
        availability,
        contentSha256: availability === "available" ? digest.trim() : null,
        byteSize: availability === "available" ? 0 : null,
        unavailableReason: availability === "unavailable" ? reason.trim() : null,
      });
      setName("");
      setReason("");
      setDigest("");
      await load();
    } catch (e) {
      setMessage(errText(e));
    }
  };

  if (state === "loading") return <ClinicalLoading label="Reading the source inventory…" />;
  if (state === "error") return <PanelError error={error} onRetry={load} />;

  return (
    <div className="flex flex-col gap-4">
      <ClinicalNote>
        Declaring a file records <strong>what was looked for</strong>, including files that could
        not be read. An inventory with nothing in it is not the same as an import that found
        nothing — and this list is the difference between those two sentences.
      </ClinicalNote>

      <Card>
        <CardTitle>Declare a source file</CardTitle>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <Field label="File name (not a path)">
            <TextInput
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="products.xlsx"
              data-testid="source-name"
            />
          </Field>
          <Field label="Availability">
            <Select
              value={availability}
              onChange={(e) => setAvailability(e.target.value as "available" | "unavailable")}
              data-testid="source-availability"
            >
              <option value="unavailable">Not available to read</option>
              <option value="available">Available and hashed</option>
            </Select>
          </Field>
          {availability === "available" ? (
            <Field label="sha256 digest">
              <TextInput
                value={digest}
                onChange={(e) => setDigest(e.target.value)}
                placeholder="64 hex characters"
                data-testid="source-digest"
              />
            </Field>
          ) : (
            <Field label="Why it could not be read">
              <TextInput
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder='"Not found" and "withheld" are different facts'
                data-testid="source-reason"
              />
            </Field>
          )}
        </div>
        <div className="mt-3 flex items-center gap-3">
          <Btn onClick={declare} disabled={!name.trim()} data-testid="declare-source">
            Record this file
          </Btn>
          {message && (
            <p className="m-0 text-[12px] text-danger" role="alert" data-testid="source-error">
              {message}
            </p>
          )}
        </div>
      </Card>

      <Card>
        <CardTitle>
          Declared files · {data?.counts.declared ?? 0} ({data?.counts.available ?? 0} read,{" "}
          {data?.counts.unavailable ?? 0} not read)
        </CardTitle>
        {data && data.files.length === 0 ? (
          <p className="m-0 text-[12.5px] text-subtle" data-testid="sources-empty">
            {data.emptyStateMessage}
          </p>
        ) : (
          <TableWrap>
            <thead>
              <tr>
                <TH>File</TH>
                <TH>Availability</TH>
                <TH>Digest</TH>
                <TH>Batches</TH>
              </tr>
            </thead>
            <tbody>
              {data?.files.map((f) => (
                <tr key={f.id} data-testid="source-row">
                  <TD>{f.declaredName}</TD>
                  <TD>
                    {f.availability === "available" ? (
                      <Chip tone="ok">Read</Chip>
                    ) : (
                      <span className="flex flex-col gap-[2px]">
                        <Chip tone="warn">Not read</Chip>
                        <span className="text-[11.5px] text-subtle">{f.unavailableReason}</span>
                      </span>
                    )}
                  </TD>
                  <TD className="font-mono text-[11px]">
                    {f.contentSha256 ? `${f.contentSha256.slice(0, 12)}…` : "Unknown"}
                  </TD>
                  <TD>{f.batchCount}</TD>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </Card>
    </div>
  );
}

/* --------------------------------------------------------------- parse */

function ParsePanel({ onStaged }: { onStaged: (batchId: string) => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [kind, setKind] = useState<"product_spreadsheet" | "protocol_document">(
    "product_spreadsheet",
  );
  const [envelope, setEnvelope] = useState<LiveParsedImportEnvelope | null>(null);
  const [attested, setAttested] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const parse = async () => {
    const file = fileRef.current?.files?.[0];
    if (!file) return;
    setBusy(true);
    setMessage("");
    setEnvelope(null);
    setAttested(false);
    try {
      setEnvelope(await liveClient.knowledgeImportParse({ file, sourceKind: kind }));
    } catch (e) {
      setMessage(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const stage = async () => {
    if (!envelope) return;
    setBusy(true);
    setMessage("");
    try {
      const result = await liveClient.knowledgeImportPreview({
        sourceKind: envelope.sourceKind,
        sourceName: envelope.sourceName,
        schemaVersion: envelope.schemaVersion,
        items: envelope.items,
        attestsNoPhi: true,
        sourceFilename: envelope.sourceFilename,
        sourceByteSize: envelope.sourceByteSize,
      });
      onStaged(result.batchId);
    } catch (e) {
      setMessage(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <ClinicalNote>
        The file is read <strong>in this process and nowhere else</strong>. Formulas are never
        calculated, macros and embedded objects are refused outright, and links out of the document
        are discarded. Nothing is written by parsing — staging is the separate step below.
      </ClinicalNote>

      <Card>
        <CardTitle>Read a file</CardTitle>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="What kind of file is this?">
            <Select
              value={kind}
              onChange={(e) =>
                setKind(e.target.value as "product_spreadsheet" | "protocol_document")
              }
              data-testid="parse-kind"
            >
              <option value="product_spreadsheet">Product spreadsheet (.xlsx)</option>
              <option value="protocol_document">Protocol document (.docx)</option>
            </Select>
          </Field>
          <input
            ref={fileRef}
            type="file"
            accept=".xlsx,.docx"
            aria-label="Source file"
            data-testid="parse-file"
            className="text-[12.5px]"
          />
          <Btn onClick={parse} disabled={busy} data-testid="parse-run">
            {busy ? "Reading…" : "Read the file"}
          </Btn>
        </div>
        {message && (
          <p className="m-0 mt-3 text-[12.5px] text-danger" role="alert" data-testid="parse-error">
            {message}
          </p>
        )}
      </Card>

      {envelope && (
        <Card>
          <CardTitle>
            {envelope.sourceFilename} · {envelope.report.itemCount} row(s) read
          </CardTitle>
          <dl className="grid grid-cols-2 gap-2 text-[12px] md:grid-cols-4">
            <div>
              <dt className="text-subtle">Digest</dt>
              <dd className="m-0 font-mono text-[11px]" data-testid="parse-digest">
                {envelope.sourceSha256.slice(0, 16)}…
              </dd>
            </div>
            <div>
              <dt className="text-subtle">Sheets / sections</dt>
              <dd className="m-0">{envelope.report.sheetsRead.join(", ") || "Unknown"}</dd>
            </div>
            <div>
              <dt className="text-subtle">Uncalculated formulas</dt>
              <dd className="m-0" data-testid="parse-uncached">
                {envelope.report.uncachedFormulaCells}
              </dd>
            </div>
            <div>
              <dt className="text-subtle">Field codes discarded</dt>
              <dd className="m-0" data-testid="parse-fieldcodes">
                {envelope.report.discardedFieldCodes}
              </dd>
            </div>
          </dl>

          {envelope.report.notices.length > 0 && (
            <ul className="mt-3 flex list-none flex-col gap-2 p-0" data-testid="parse-notices">
              {envelope.report.notices.map((n) => (
                <li key={n} className="text-[12px] leading-[1.5] text-warning-deep">
                  {n}
                </li>
              ))}
            </ul>
          )}

          {envelope.report.skippedRows.length > 0 && (
            <div className="mt-3" data-testid="parse-skipped">
              <p className="m-0 mb-1 text-[12px] font-semibold">
                {envelope.report.skippedRows.length} row(s) were not read
              </p>
              <ul className="m-0 flex list-none flex-col gap-1 p-0">
                {envelope.report.skippedRows.map((r) => (
                  <li key={`${r.sheet}:${r.rowNumber}`} className="text-[11.5px] text-subtle">
                    {r.sheet} row {r.rowNumber}: {r.why}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <label className="mt-4 flex items-start gap-2 text-[12.5px]">
            <input
              type="checkbox"
              checked={attested}
              onChange={(e) => setAttested(e.target.checked)}
              data-testid="parse-attest"
            />
            <span>
              I confirm this file contains <strong>no patient-identifiable information</strong>.
              This is a statement I am making, not a box the importer ticked.
            </span>
          </label>
          <div className="mt-3">
            <Btn
              onClick={stage}
              disabled={!attested || busy || envelope.items.length === 0}
              data-testid="parse-stage"
            >
              Stage for review
            </Btn>
          </div>
        </Card>
      )}
    </div>
  );
}

/* -------------------------------------------------------------- review */

function ItemRow({
  item,
  onResolve,
}: {
  item: LiveKnowledgeImportItem;
  onResolve: (item: LiveKnowledgeImportItem) => void;
}) {
  const missing = item.missingFacts ?? [];
  const flags = item.restrictedFlags ?? [];
  const diffs = item.fieldDiffs ?? [];

  return (
    <tr data-testid="review-item">
      <TD>
        <span className="font-semibold">{item.displayName}</span>
        <span className="block text-[11px] text-subtle">
          {item.sourceSheet ?? "—"} row {item.sourceRowNumber ?? "—"}
        </span>
      </TD>
      <TD>
        {item.changeKind === "ambiguous" ? (
          <Chip tone="danger">Ambiguous</Chip>
        ) : item.changeKind === "conflict" ? (
          <Chip tone="danger">Conflict</Chip>
        ) : item.changeKind === "change" ? (
          <Chip tone="warn">Change</Chip>
        ) : item.changeKind === "unchanged" ? (
          <Chip tone="muted">Unchanged</Chip>
        ) : (
          <Chip tone="ok">New</Chip>
        )}
      </TD>
      <TD>
        {flags.length === 0 ? (
          <span className="text-[11.5px] text-subtle">None declared</span>
        ) : (
          <span className="flex flex-wrap gap-1" data-testid="item-restricted">
            {flags.map((f) => (
              <Chip key={f} tone="danger">
                {f}
              </Chip>
            ))}
          </span>
        )}
      </TD>
      <TD>
        {missing.length === 0 ? (
          <span className="text-[11.5px] text-subtle">—</span>
        ) : (
          <span className="text-[11.5px] text-warning-deep" data-testid="item-missing">
            {missing.join(", ")}
          </span>
        )}
      </TD>
      <TD>
        {diffs.length > 0 && (
          <ul className="m-0 flex list-none flex-col gap-[2px] p-0" data-testid="item-diffs">
            {diffs.map((d) => (
              <li key={d.field} className="text-[11px]">
                <span className="font-semibold">{d.field}</span>{" "}
                <span className="text-subtle line-through">{d.current ?? "Unknown"}</span>{" "}
                <span aria-hidden>→</span> <span>{d.incoming ?? "Unknown"}</span>
              </li>
            ))}
          </ul>
        )}
        {item.changeKind === "ambiguous" && (
          <div data-testid="item-candidates">
            <p className="m-0 text-[11.5px] text-danger">{item.conflictReason}</p>
            <Btn
              variant="ghost"
              onClick={() => onResolve(item)}
              data-testid="resolve-ambiguity"
              className="mt-1"
            >
              Resolve
            </Btn>
          </div>
        )}
        {item.validationErrors.length > 0 && (
          <ul className="m-0 flex list-none flex-col p-0" data-testid="item-errors">
            {item.validationErrors.map((e) => (
              <li key={e} className="text-[11.5px] text-danger">
                {e}
              </li>
            ))}
          </ul>
        )}
      </TD>
    </tr>
  );
}

function ReviewPanel({ batchId }: { batchId: string | null }) {
  const [state, setState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [error, setError] = useState<unknown>(null);
  const [preview, setPreview] = useState<LiveKnowledgeImportPreview | null>(null);
  const [resolving, setResolving] = useState<LiveKnowledgeImportItem | null>(null);
  const [resolution, setResolution] = useState<"new_product" | "same_as_existing" | "skip">(
    "new_product",
  );
  const [candidateId, setCandidateId] = useState("");
  const [note, setNote] = useState("");
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    if (!batchId) return;
    setState("loading");
    try {
      setPreview(await liveClient.knowledgeImportDetail(batchId));
      setState("ready");
    } catch (e) {
      setError(e);
      setState("error");
    }
  }, [batchId]);

  useEffect(() => {
    void load();
  }, [load]);

  const submitResolution = async () => {
    if (!resolving) return;
    setMessage("");
    try {
      await liveClient.knowledgeImportResolveAmbiguity({
        itemId: resolving.id,
        resolution,
        note: note.trim(),
        existingProductId: resolution === "same_as_existing" ? candidateId : null,
      });
      setResolving(null);
      setNote("");
      setCandidateId("");
      await load();
    } catch (e) {
      setMessage(errText(e));
    }
  };

  const commit = async () => {
    if (!preview) return;
    setMessage("");
    try {
      const result = await liveClient.knowledgeImportCommit({
        batchId: preview.batch.id,
        expectedCounts: { added: preview.batch.added, changed: preview.batch.changed },
        note: "Committed from the import review workspace",
      });
      setMessage(result.message);
      await load();
    } catch (e) {
      setMessage(errText(e));
    }
  };

  if (!batchId) {
    return (
      <Card className="px-6 py-10">
        <p className="m-0 text-center text-[12.5px] text-subtle" data-testid="review-none">
          No batch is open. Read a file on the previous tab and stage it, or open a batch from the
          import history.
        </p>
      </Card>
    );
  }
  if (state === "loading" || state === "idle") return <ClinicalLoading label="Reading the staged batch…" />;
  if (state === "error") return <PanelError error={error} onRetry={load} />;
  if (!preview) return null;

  const b = preview.batch;
  const blocked = (b.ambiguous ?? 0) > 0 || b.conflicts > 0;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardTitle>
          {b.sourceName} · {b.itemCount} row(s) staged
        </CardTitle>
        <div className="flex flex-wrap gap-2" data-testid="batch-counts">
          <Chip tone="ok">{b.added} new</Chip>
          <Chip tone="warn">{b.changed} changed</Chip>
          <Chip tone="muted">{b.unchanged} unchanged</Chip>
          <Chip tone="danger">{b.conflicts} conflict</Chip>
          <Chip tone="danger">{b.ambiguous ?? 0} ambiguous</Chip>
          <Chip tone="danger">{b.restricted ?? 0} restricted</Chip>
        </div>
        <ClinicalNote className="mt-3">
          Nothing here has been written. Everything this batch applies enters as a{" "}
          <strong>non-approved draft</strong>, and an imported product is not selectable in the
          protocol picker until its review is completed separately.
        </ClinicalNote>
        <div className="mt-3 flex items-center gap-3">
          <Btn onClick={commit} disabled={blocked || b.status === "committed"} data-testid="commit-batch">
            Commit this batch
          </Btn>
          {blocked && (
            <p className="m-0 text-[12px] text-danger" data-testid="commit-blocked">
              {b.conflicts > 0 && `${b.conflicts} conflict(s) `}
              {(b.ambiguous ?? 0) > 0 && `${b.ambiguous} ambiguous row(s) `}
              must be resolved before this batch can be committed.
            </p>
          )}
          {message && (
            <p className="m-0 text-[12px] text-subtle" role="status" data-testid="commit-message">
              {message}
            </p>
          )}
        </div>
      </Card>

      <Card>
        <CardTitle>Rows</CardTitle>
        <TableWrap>
          <thead>
            <tr>
              <TH>Row</TH>
              <TH>Change</TH>
              <TH>Restricted</TH>
              <TH>Missing facts</TH>
              <TH>What needs a decision</TH>
            </tr>
          </thead>
          <tbody>
            {preview.items.map((item) => (
              <ItemRow key={item.id} item={item} onResolve={setResolving} />
            ))}
          </tbody>
        </TableWrap>
      </Card>

      {resolving && (
        <Card data-testid="ambiguity-dialog">
          <CardTitle>Resolve: {resolving.displayName}</CardTitle>
          <p className="m-0 mb-3 text-[12px] text-subtle">{resolving.conflictReason}</p>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <Field label="What is this row?">
              <Select
                value={resolution}
                onChange={(e) =>
                  setResolution(e.target.value as "new_product" | "same_as_existing" | "skip")
                }
                data-testid="ambiguity-resolution"
              >
                <option value="new_product">A genuinely new product</option>
                <option value="same_as_existing">The same as an existing product</option>
                <option value="skip">Do not apply this row</option>
              </Select>
            </Field>
            {resolution === "same_as_existing" && (
              <Field label="Which existing product?">
                <Select
                  value={candidateId}
                  onChange={(e) => setCandidateId(e.target.value)}
                  data-testid="ambiguity-candidate"
                >
                  <option value="">Choose one…</option>
                  {(resolving.candidateMatches ?? []).map((c) => (
                    <option key={c.productId} value={c.productId}>
                      {c.name} — {c.brand ?? "Unknown brand"} ({c.sku ?? "no SKU"}) · {c.why}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
          </div>
          <Field label="Why — this is recorded against the decision">
            <TextInput
              value={note}
              onChange={(e) => setNote(e.target.value)}
              data-testid="ambiguity-note"
            />
          </Field>
          <div className="mt-3 flex items-center gap-3">
            <Btn onClick={submitResolution} disabled={!note.trim()} data-testid="ambiguity-submit">
              Record this decision
            </Btn>
            <Btn variant="ghost" onClick={() => setResolving(null)}>
              Cancel
            </Btn>
            {message && (
              <p className="m-0 text-[12px] text-danger" role="alert" data-testid="ambiguity-error">
                {message}
              </p>
            )}
          </div>
        </Card>
      )}
    </div>
  );
}

/* ---------------------------------------------------------- provenance */

function ProvenancePanel() {
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<unknown>(null);
  const [data, setData] = useState<LiveImportProvenanceHistory | null>(null);

  const load = useCallback(async () => {
    setState("loading");
    try {
      setData(await liveClient.importProvenance({ limit: 100 }));
      setState("ready");
    } catch (e) {
      setError(e);
      setState("error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (state === "loading") return <ClinicalLoading label="Reading the provenance history…" />;
  if (state === "error") return <PanelError error={error} onRetry={load} />;

  return (
    <div className="flex flex-col gap-4">
      <ClinicalNote>
        This history is <strong>append-only</strong>. A record of where content came from that
        could be edited would answer the question with whatever the last writer preferred, which is
        worse than not recording it — it would look like evidence.
      </ClinicalNote>

      <Card>
        <CardTitle>Imported records · {data?.total ?? 0}</CardTitle>
        {data && data.records.length === 0 ? (
          <p className="m-0 text-[12.5px] text-subtle" data-testid="provenance-empty">
            {data.emptyStateMessage}
          </p>
        ) : (
          <TableWrap>
            <thead>
              <tr>
                <TH>Record</TH>
                <TH>From</TH>
                <TH>Source values</TH>
                <TH>Missing facts</TH>
              </tr>
            </thead>
            <tbody>
              {data?.records.map((r) => (
                <tr key={r.id} data-testid="provenance-row">
                  <TD>
                    <span className="font-mono text-[11px]">{r.refType}</span>
                    <span className="block text-[11px] text-subtle">
                      {r.payloadSha256.slice(0, 12)}…
                    </span>
                  </TD>
                  <TD className="text-[11.5px]">
                    {r.sourceFileName ?? "Unknown file"}
                    <span className="block text-subtle">
                      {r.sourceSheet ?? "—"} row {r.sourceRowNumber ?? "—"}
                    </span>
                  </TD>
                  <TD className="max-w-[360px] text-[11px]" data-testid="provenance-raw">
                    {Object.entries(r.rawValues).length === 0 ? (
                      <span className="text-subtle">No verbatim row was recorded.</span>
                    ) : (
                      Object.entries(r.rawValues)
                        .map(([k, v]) => `${k}: ${String(v)}`)
                        .join(" · ")
                    )}
                  </TD>
                  <TD className="text-[11.5px]">
                    {r.missingFacts.length === 0 ? "—" : r.missingFacts.join(", ")}
                  </TD>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------- shell */

/* ==================================================================
 * PHASE 9E-A.1 — NEW GOVERNANCE PANELS
 * ==================================================================
 *
 * OverviewPanel — composite counts + workflow-stage pointer.
 * BatchesPanel  — list preview / cancelled batches for the org.
 * ConflictsPanel — all ordinary conflicts across all preview batches,
 *                  with side-by-side rows, field-level diff, and the
 *                  three governed decisions (keep_existing /
 *                  take_incoming / skip), each demanding a reason.
 * RestrictedReviewPanel — 5-outcome restricted review with per-item
 *                  history, category filters, and jurisdiction input
 *                  when the outcome demands it.
 * ComingIn9EA2Panel — a clearly-labelled placeholder for the three
 *                  deferred sections (Product labels, Knowledge
 *                  references, Commercial matching). It states
 *                  exactly what is missing and where the work will
 *                  land. No dead buttons.
 */

/* ------------------------------------------------------------- overview */

function OverviewPanel({
  onNavigate,
}: {
  onNavigate: (t: Tab) => void;
}) {
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<unknown>(null);
  const [inv, setInv] = useState<LiveImportSourceInventory | null>(null);
  const [queue, setQueue] = useState<LiveCatalogReviewQueue | null>(null);

  const load = useCallback(async () => {
    setState("loading");
    try {
      const [i, q] = await Promise.all([
        liveClient.importSourceInventory(),
        liveClient.catalogReviewQueue(),
      ]);
      setInv(i);
      setQueue(q);
      setState("ready");
    } catch (e) {
      setError(e);
      setState("error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (state === "loading") return <ClinicalLoading label="Reading the import inventory…" />;
  if (state === "error") return <PanelError error={error} onRetry={load} />;

  const declared = inv?.files.length ?? 0;
  const available = (inv?.files ?? []).filter((f) => f.availability === "available").length;
  const products = queue?.products ?? [];
  const restrictedCount = products.filter((p) => (p.restrictedFlags ?? []).length > 0).length;
  const notSelectable = queue?.counts?.notSelectable ?? 0;

  // The workflow pointer: preview → resolve conflicts → commit as draft →
  // complete missing facts → restriction/evidence review → label
  // verification → clinical approval → selectable. The pointer highlights
  // the earliest stage that has outstanding work.
  const stages = [
    {
      key: "sources" as Tab,
      label: "Declare source files",
      done: declared > 0,
      todo: declared === 0 ? "No files declared yet." : null,
      go: () => onNavigate("sources"),
    },
    {
      key: "parse" as Tab,
      label: "Stage a batch (preview)",
      done: declared > 0 && available > 0,
      todo:
        available === 0 && declared > 0
          ? "Read an available file into a preview batch."
          : declared === 0
            ? null
            : null,
      go: () => onNavigate("parse"),
    },
    {
      key: "conflicts" as Tab,
      label: "Resolve conflicts",
      done: false,
      todo: "Open the Conflicts tab to walk any batch-level collisions.",
      go: () => onNavigate("conflicts"),
    },
    {
      key: "restricted" as Tab,
      label: "Restricted review",
      done: false,
      todo:
        restrictedCount > 0
          ? `${restrictedCount} restricted product(s) waiting for a decision.`
          : "No restricted rows in the current queue.",
      go: () => onNavigate("restricted"),
    },
    {
      key: "labels" as Tab,
      label: "Complete missing product facts (label editor)",
      done: false,
      todo:
        notSelectable > 0
          ? `${notSelectable} product(s) not yet selectable. The label editor arrives in Phase 9E-A.2.`
          : "The label editor arrives in Phase 9E-A.2.",
      go: () => onNavigate("labels"),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardTitle>Where the workspace is</CardTitle>
        <div className="grid gap-2 md:grid-cols-3">
          <div data-testid="ov-counts-declared">
            <div className="text-[11px] uppercase tracking-wide text-subtle">Source files declared</div>
            <div className="text-[22px] font-bold">{declared}</div>
            <div className="text-[11px] text-subtle">{available} available on the operator&rsquo;s system.</div>
          </div>
          <div data-testid="ov-counts-restricted">
            <div className="text-[11px] uppercase tracking-wide text-subtle">Restricted products in queue</div>
            <div className="text-[22px] font-bold">{restrictedCount}</div>
            <div className="text-[11px] text-subtle">Each needs a governed decision to leave the queue.</div>
          </div>
          <div data-testid="ov-counts-not-selectable">
            <div className="text-[11px] uppercase tracking-wide text-subtle">Not-yet-selectable products</div>
            <div className="text-[22px] font-bold">{notSelectable}</div>
            <div className="text-[11px] text-subtle">
              Not selectable until the missing product facts are entered from an official label.
            </div>
          </div>
        </div>
      </Card>

      <Card>
        <CardTitle>The mandatory workflow</CardTitle>
        <ClinicalNote className="mb-3">
          preview &rarr; resolve conflicts &rarr; commit as draft &rarr; complete missing facts
          &rarr; restriction/evidence review &rarr; label verification &rarr; clinical approval
          &rarr; selectable. Nothing skips a stage.
        </ClinicalNote>
        <ul className="flex flex-col gap-2" data-testid="ov-stages">
          {stages.map((s, idx) => (
            <li
              key={s.label}
              className="flex items-center justify-between rounded border border-line bg-card px-3 py-2"
              data-testid={`ov-stage-${idx + 1}`}
            >
              <div className="flex flex-col">
                <span className="text-[12.5px] font-semibold">
                  {idx + 1}. {s.label}
                </span>
                {s.todo && <span className="text-[11.5px] text-subtle">{s.todo}</span>}
              </div>
              {s.go && (
                <Btn variant="ghost" onClick={s.go} data-testid={`ov-goto-${s.key}`}>
                  Go &rarr;
                </Btn>
              )}
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

/* --------------------------------------------------------------- conflicts */

/**
 * Field-level diff between an "existing" row and an "incoming" row.
 * `existing` is the row already in the batch (or the state at import
 * time); `incoming` is the row that raised the conflict. This surfaces
 * every field, marking the ones that differ.
 */
function DiffRows({
  existing,
  incoming,
}: {
  existing: LiveKnowledgeImportItem | null;
  incoming: LiveKnowledgeImportItem;
}) {
  const rows: Array<{ label: string; a: string; b: string; differs: boolean }> = [];
  const push = (label: string, a: unknown, b: unknown) => {
    const av = a == null ? "" : String(a);
    const bv = b == null ? "" : String(b);
    rows.push({ label, a: av, b: bv, differs: av !== bv });
  };
  push("Display name", existing?.displayName, incoming.displayName);
  push("Entity type", existing?.entityType, incoming.entityType);
  push("Change kind", existing?.changeKind, incoming.changeKind);
  push("Restricted flags", (existing?.restrictedFlags ?? []).join(","), (incoming.restrictedFlags ?? []).join(","));
  push("Missing facts", (existing?.missingFacts ?? []).join(","), (incoming.missingFacts ?? []).join(","));
  push("Warnings", (existing?.warnings ?? []).join(" | "), (incoming.warnings ?? []).join(" | "));
  return (
    <TableWrap>
      <thead>
        <tr>
          <TH>Field</TH>
          <TH>Existing row</TH>
          <TH>Incoming row</TH>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.label} className={r.differs ? "bg-warning-tint/40" : ""}>
            <TD>
              <strong>{r.label}</strong>
              {r.differs && (
                <span className="ml-2 text-[10.5px] font-bold uppercase tracking-wide text-warning-deep">
                  differs
                </span>
              )}
            </TD>
            <TD>{r.a || <span className="text-subtle">Unknown</span>}</TD>
            <TD>{r.b || <span className="text-subtle">Unknown</span>}</TD>
          </tr>
        ))}
      </tbody>
    </TableWrap>
  );
}

function ConflictsPanel({ batchId }: { batchId: string | null }) {
  const [state, setState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [error, setError] = useState<unknown>(null);
  const [preview, setPreview] = useState<LiveKnowledgeImportPreview | null>(null);
  const [resolving, setResolving] = useState<LiveKnowledgeImportItem | null>(null);
  const [resolution, setResolution] = useState<"keep_existing" | "take_incoming" | "skip">(
    "keep_existing",
  );
  const [note, setNote] = useState("");
  const [message, setMessage] = useState("");
  const [confirm, setConfirm] = useState(false);

  const load = useCallback(async () => {
    if (!batchId) return;
    setState("loading");
    try {
      setPreview(await liveClient.knowledgeImportDetail(batchId));
      setState("ready");
    } catch (e) {
      setError(e);
      setState("error");
    }
  }, [batchId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!batchId) {
    return (
      <Card className="px-6 py-10">
        <p className="m-0 text-center text-[12.5px] text-subtle" data-testid="conflicts-no-batch">
          No batch is open. Read a file on the &ldquo;Read a file&rdquo; tab and stage it,
          or open a batch on the &ldquo;Preview batches&rdquo; tab.
        </p>
      </Card>
    );
  }
  if (state === "loading" || state === "idle") return <ClinicalLoading label="Reading the batch…" />;
  if (state === "error") return <PanelError error={error} onRetry={load} />;

  const conflicts = (preview?.items ?? []).filter((i) => i.changeKind === "conflict");

  const submit = async () => {
    if (!resolving) return;
    setMessage("");
    try {
      await liveClient.knowledgeImportResolveConflict({
        itemId: resolving.id,
        resolution,
        note: note.trim(),
      });
      setResolving(null);
      setResolution("keep_existing");
      setNote("");
      setConfirm(false);
      await load();
    } catch (e) {
      setMessage(errText(e));
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardTitle>Conflicts in this batch</CardTitle>
        <p className="m-0 text-[12px] text-subtle">
          Ordinary conflicts: two rows in the same batch stake a claim on the same identity.
          Pick the answer that carries the correct clinical fact. Every decision demands a
          reason and is audit-logged. Restrictions on either row are preserved on every
          outcome; no downgrading happens here.
        </p>
      </Card>

      <Card>
        <CardTitle>
          {conflicts.length} conflict(s) in {preview?.batch.sourceName ?? "this batch"}
        </CardTitle>
        {conflicts.length === 0 ? (
          <p className="m-0 text-center text-[12px] text-subtle" data-testid="conflicts-empty">
            No conflicts in this batch.
          </p>
        ) : (
          <ul className="flex flex-col gap-2" data-testid="conflicts-list">
            {conflicts.map((c) => (
              <li
                key={c.id}
                className="rounded border border-line px-3 py-2"
                data-testid={`conflict-item-${c.id}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <strong className="text-[13px]">{c.displayName}</strong>
                    <div className="text-[11.5px] text-subtle">
                      {c.entityType} · source row {c.sourceRowNumber ?? "?"} in{" "}
                      {c.sourceSheet ?? "unknown sheet"}
                    </div>
                  </div>
                  <Btn onClick={() => setResolving(c)} data-testid={`conflict-open-${c.id}`}>
                    Resolve
                  </Btn>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {resolving && (
        <Card data-testid="conflict-dialog">
          <CardTitle>Resolve: {resolving.displayName}</CardTitle>
          <p className="m-0 mb-3 text-[12px] text-subtle">
            {resolving.conflictReason ?? "This row conflicts with another row in the same batch."}
          </p>
          <DiffRows
            existing={
              (preview?.items ?? []).find(
                (i) => i.id === resolving.conflictWithItemId,
              ) ?? null
            }
            incoming={resolving}
          />
          <div className="mt-3 flex flex-col gap-3 md:flex-row md:items-end">
            <Field label="Decision">
              <Select
                value={resolution}
                onChange={(e) =>
                  setResolution(e.target.value as "keep_existing" | "take_incoming" | "skip")
                }
                data-testid="conflict-resolution"
              >
                <option value="keep_existing">Keep the existing row (the earlier one wins)</option>
                <option value="take_incoming">Use the incoming row (supersedes the earlier one)</option>
                <option value="skip">Skip the incoming row (neither is applied)</option>
              </Select>
            </Field>
            <Field label="Why — recorded against the decision" className="flex-1">
              <TextInput
                value={note}
                onChange={(e) => setNote(e.target.value)}
                data-testid="conflict-note"
              />
            </Field>
          </div>
          {!confirm && (
            <div className="mt-3 flex items-center gap-3">
              <Btn
                onClick={() => setConfirm(true)}
                disabled={!note.trim()}
                data-testid="conflict-review"
              >
                Review this decision
              </Btn>
              <Btn variant="ghost" onClick={() => setResolving(null)}>
                Cancel
              </Btn>
            </div>
          )}
          {confirm && (
            <div
              className="mt-3 rounded border border-warning/25 bg-warning-tint px-3 py-2"
              data-testid="conflict-confirm"
            >
              <p className="m-0 text-[12px] text-warning-deep">
                About to record: <strong>{resolution}</strong> on{" "}
                <strong>{resolving.displayName}</strong>. Restrictions on either row are
                preserved. This action is audit-logged and cannot be edited later.
              </p>
              <div className="mt-2 flex items-center gap-2">
                <Btn onClick={submit} data-testid="conflict-submit">
                  Record this decision
                </Btn>
                <Btn variant="ghost" onClick={() => setConfirm(false)}>
                  Back
                </Btn>
              </div>
            </div>
          )}
          {message && (
            <p
              className="mt-3 text-[12px] text-danger"
              role="alert"
              data-testid="conflict-error"
            >
              {message}
            </p>
          )}
        </Card>
      )}
    </div>
  );
}

/* -------------------------------------------------------- restricted review */

const RESTRICTED_OUTCOMES: Array<{
  id:
    | "retain_restricted"
    | "request_evidence"
    | "defer"
    | "reject"
    | "clinician_reviewed_for_jurisdiction";
  label: string;
  description: string;
}> = [
  {
    id: "retain_restricted",
    label: "Retain restricted",
    description: "Looked at it; the flag stays.",
  },
  {
    id: "request_evidence",
    label: "Request evidence",
    description: "Need a citation before deciding.",
  },
  {
    id: "defer",
    label: "Defer",
    description: "Not ready to decide today.",
  },
  {
    id: "reject",
    label: "Reject",
    description: "This row will not be used.",
  },
  {
    id: "clinician_reviewed_for_jurisdiction",
    label: "Clinician-reviewed for jurisdiction",
    description: "Requires a stated jurisdiction. This is NOT approval.",
  },
];

/**
 * Category filters mirror the restriction taxonomy Phase 9D uses across
 * the pipeline: vaccine-related, peptide, prescription, IV therapy, device,
 * jurisdictional, suspected-restricted. A row can match more than one.
 */
const RESTRICTED_CATEGORIES: Array<{ id: string; label: string; match: RegExp }> = [
  { id: "vaccine_related", label: "Vaccine-related", match: /vaccine|mrna|spike/i },
  { id: "peptide", label: "Peptide", match: /peptide/i },
  { id: "prescription", label: "Prescription", match: /prescription|controlled|schedule/i },
  { id: "iv_therapy", label: "IV therapy", match: /iv|intravenous|infusion|injection/i },
  { id: "device", label: "Device", match: /device|hyperbaric|hbot|pemf|photobiomodulation/i },
  { id: "jurisdictional", label: "Jurisdictional", match: /jurisdiction|not for sale|fda|mhra|tga/i },
  { id: "suspected_restricted", label: "Suspected", match: /suspected_restricted/i },
];

function RestrictedReviewPanel() {
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<unknown>(null);
  const [queue, setQueue] = useState<LiveCatalogReviewQueue | null>(null);
  const [category, setCategory] = useState<string>("all");
  const [openId, setOpenId] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<
    | "retain_restricted"
    | "request_evidence"
    | "defer"
    | "reject"
    | "clinician_reviewed_for_jurisdiction"
  >("retain_restricted");
  const [reason, setReason] = useState("");
  const [jurisdiction, setJurisdiction] = useState("");
  const [history, setHistory] = useState<{
    productId: string;
    currentOutcome: string | null;
    history: Array<{
      id: string;
      outcome: string;
      reason: string;
      jurisdiction: string | null;
      decidedAt: string;
    }>;
  } | null>(null);
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    setState("loading");
    try {
      setQueue(await liveClient.catalogReviewQueue());
      setState("ready");
    } catch (e) {
      setError(e);
      setState("error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const loadHistory = useCallback(async (productId: string) => {
    try {
      const h = await liveClient.restrictedReviewHistory(productId);
      setHistory(h);
    } catch {
      setHistory({ productId, currentOutcome: null, history: [] });
    }
  }, []);

  const openHistory = useCallback(async (productId: string) => {
    setOpenId(productId);
    setHistory(null);
    setOutcome("retain_restricted");
    setReason("");
    setJurisdiction("");
    setMessage("");
    await loadHistory(productId);
  }, [loadHistory]);

  if (state === "loading") return <ClinicalLoading label="Reading the restricted queue…" />;
  if (state === "error") return <PanelError error={error} onRetry={load} />;

  const products = queue?.products ?? [];
  const restricted = products.filter((p) => (p.restrictedFlags ?? []).length > 0);
  const filtered = restricted.filter((p) => {
    if (category === "all") return true;
    const cat = RESTRICTED_CATEGORIES.find((c) => c.id === category);
    if (!cat) return true;
    return (p.restrictedFlags ?? []).some((f) => cat.match.test(f));
  });

  const submit = async () => {
    if (!openId) return;
    setMessage("");
    try {
      const result = await liveClient.restrictedReviewRecord({
        productId: openId,
        outcome,
        reason: reason.trim(),
        jurisdiction: outcome === "clinician_reviewed_for_jurisdiction" ? jurisdiction.trim() : null,
      });
      setMessage(
        `Recorded ${result.outcome}. Restrictions preserved on this product; clearance is a separate action.`,
      );
      // Reload history WITHOUT resetting the message the reviewer just
      // triggered — openHistory() clears message as part of preparing a
      // fresh decision, and calling it here would erase the confirmation
      // before the operator has read it.
      await loadHistory(openId);
      await load();
    } catch (e) {
      setMessage(errText(e));
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardTitle>Restricted review</CardTitle>
        <p className="m-0 text-[12px] text-subtle">
          All {restricted.length} restricted products in this org&rsquo;s catalog. Five governed
          outcomes; each demands a reason. The clinician-for-jurisdiction outcome additionally
          demands a stated jurisdiction. <strong>None of the five outcomes clears the restriction</strong>{" "}
          — clearance stays a separate governed action.
        </p>
        <div className="mt-3 flex flex-wrap gap-2" data-testid="restricted-filters">
          <button
            type="button"
            className={cn(
              "rounded-full border px-3 py-1 text-[11.5px] font-semibold",
              category === "all"
                ? "border-action bg-action/10 text-action"
                : "border-line bg-card text-body",
            )}
            onClick={() => setCategory("all")}
            data-testid="restricted-filter-all"
          >
            All ({restricted.length})
          </button>
          {RESTRICTED_CATEGORIES.map((c) => {
            const count = restricted.filter((p) =>
              (p.restrictedFlags ?? []).some((f) => c.match.test(f)),
            ).length;
            return (
              <button
                key={c.id}
                type="button"
                className={cn(
                  "rounded-full border px-3 py-1 text-[11.5px] font-semibold",
                  category === c.id
                    ? "border-action bg-action/10 text-action"
                    : "border-line bg-card text-body",
                )}
                onClick={() => setCategory(c.id)}
                data-testid={`restricted-filter-${c.id}`}
                disabled={count === 0}
              >
                {c.label} ({count})
              </button>
            );
          })}
        </div>
      </Card>

      <Card>
        <CardTitle>
          {filtered.length} product(s)
          {category !== "all" && ` in ${RESTRICTED_CATEGORIES.find((c) => c.id === category)?.label}`}
        </CardTitle>
        {filtered.length === 0 ? (
          <p
            className="m-0 text-center text-[12px] text-subtle"
            data-testid="restricted-empty"
          >
            No restricted products match this filter.
          </p>
        ) : (
          <ul className="flex flex-col gap-2" data-testid="restricted-list">
            {filtered.map((p) => (
              <li
                key={p.productId}
                className="flex items-center justify-between rounded border border-line px-3 py-2"
                data-testid={`restricted-item-${p.productId}`}
              >
                <div>
                  <strong className="text-[13px]">{p.name}</strong>
                  <div className="text-[11.5px] text-subtle">
                    {(p.restrictedFlags ?? []).map((f) => (
                      <Chip key={f} tone="danger">
                        {f}
                      </Chip>
                    ))}
                    {(p.missingFacts ?? []).length > 0 && (
                      <span className="ml-2">
                        Missing: {(p.missingFacts ?? []).join(", ")}
                      </span>
                    )}
                  </div>
                </div>
                <Btn
                  variant="ghost"
                  onClick={() => openHistory(p.productId)}
                  data-testid={`restricted-open-${p.productId}`}
                >
                  Decide
                </Btn>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {openId && (
        <Card data-testid="restricted-dialog">
          <CardTitle>Decide</CardTitle>
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="Outcome">
              <Select
                value={outcome}
                onChange={(e) =>
                  setOutcome(
                    e.target.value as
                      | "retain_restricted"
                      | "request_evidence"
                      | "defer"
                      | "reject"
                      | "clinician_reviewed_for_jurisdiction",
                  )
                }
                data-testid="restricted-outcome"
              >
                {RESTRICTED_OUTCOMES.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </Field>
            {outcome === "clinician_reviewed_for_jurisdiction" && (
              <Field label="Jurisdiction (required for this outcome)">
                <TextInput
                  value={jurisdiction}
                  onChange={(e) => setJurisdiction(e.target.value)}
                  placeholder="e.g., US-CA"
                  data-testid="restricted-jurisdiction"
                />
              </Field>
            )}
          </div>
          <Field label="Why — recorded against the decision">
            <TextInput
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              data-testid="restricted-reason"
            />
          </Field>
          <div className="mt-3 flex items-center gap-3">
            <Btn
              onClick={submit}
              disabled={
                !reason.trim() ||
                (outcome === "clinician_reviewed_for_jurisdiction" && !jurisdiction.trim())
              }
              data-testid="restricted-submit"
            >
              Record this decision
            </Btn>
            <Btn variant="ghost" onClick={() => setOpenId(null)}>
              Close
            </Btn>
            {message && (
              <p
                className="m-0 text-[12px] text-subtle"
                role="status"
                data-testid="restricted-message"
              >
                {message}
              </p>
            )}
          </div>
          {history && history.history.length > 0 && (
            <div className="mt-4" data-testid="restricted-history">
              <div className="text-[11px] uppercase tracking-wide text-subtle">History</div>
              <ul className="mt-1 flex flex-col gap-1">
                {history.history.map((d) => (
                  <li key={d.id} className="text-[11.5px]" data-testid={`restricted-history-${d.id}`}>
                    <strong>{d.outcome}</strong> — {d.reason}
                    {d.jurisdiction && ` (${d.jurisdiction})`} · {d.decidedAt}
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-[11.5px] text-subtle">
                Current outcome: <strong>{history.currentOutcome ?? "none"}</strong>. Every entry is
                append-only.
              </p>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}

/* -------------------------------------------------- deferred (9E-A.2) panels */

function ComingIn9EA2Panel({
  title,
  purpose,
  bullets,
}: {
  title: string;
  purpose: string;
  bullets: Array<string>;
}) {
  return (
    <Card data-testid={`coming-9ea2-${title.replace(/\s+/g, "-").toLowerCase()}`}>
      <CardTitle>{title}</CardTitle>
      <div
        className="rounded border border-warning/25 bg-warning-tint px-3 py-2 text-[12px] text-warning-deep"
        role="note"
      >
        <p className="m-0 mb-1 font-semibold">Not available yet — Phase 9E-A.2.</p>
        <p className="m-0">{purpose}</p>
      </div>
      <p className="mt-3 text-[12px] text-subtle">What Phase 9E-A.2 will add here:</p>
      <ul className="ml-4 list-disc text-[12px] text-subtle">
        {bullets.map((b) => (
          <li key={b}>{b}</li>
        ))}
      </ul>
      <p className="mt-3 text-[11.5px] text-subtle">
        The Phase 9E-A.1 database RPCs that this section will surface{" "}
        <em>already exist</em> (governed 5-outcome restricted review and
        governed commercial matching landed in this PR&rsquo;s SQL). This
        UI is what Phase 9E-A.2 wires on top.
      </p>
    </Card>
  );
}

/* -------------------------------------------------------------- workspace */

export function ImportReviewWorkspace() {
  const [tab, setTab] = useState<Tab>("overview");
  const [batchId, setBatchId] = useState<string | null>(null);

  const tabs = useMemo(
    () =>
      [
        { id: "overview", label: "Overview" },
        { id: "sources", label: "Source files" },
        { id: "parse", label: "Read a file" },
        { id: "batches", label: "Preview batches" },
        { id: "conflicts", label: "Conflicts" },
        { id: "restricted", label: "Restricted review" },
        { id: "labels", label: "Product labels" },
        { id: "references", label: "Knowledge references" },
        { id: "commercial", label: "Commercial matching" },
        { id: "provenance", label: "Provenance & history" },
      ] as Array<{ id: Tab; label: string }>,
    [],
  );

  return (
    <div className="flex flex-col gap-4">
      {/* A local tablist rather than the URL-synced SegTabs: the open batch is
          client state, and a deep link to a tab whose batch is gone would show
          an empty panel that reads like an empty import. */}
      <div role="tablist" aria-label="Import curation workspace" className="flex flex-wrap gap-1">
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            type="button"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            data-testid={`tab-${t.id}`}
            className={cn(
              "h-8 cursor-pointer rounded-lg border px-3 text-[12.5px] font-semibold focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-action",
              tab === t.id
                ? "border-transparent bg-action text-white"
                : "border-line bg-card text-body hover:border-line-hover",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === "overview" && <OverviewPanel onNavigate={setTab} />}
      {tab === "sources" && <SourcesPanel />}
      {tab === "parse" && (
        <ParsePanel
          onStaged={(id) => {
            setBatchId(id);
            setTab("batches");
          }}
        />
      )}
      {tab === "batches" && <ReviewPanel batchId={batchId} />}
      {tab === "conflicts" && <ConflictsPanel batchId={batchId} />}
      {tab === "restricted" && <RestrictedReviewPanel />}
      {tab === "labels" && (
        <ComingIn9EA2Panel
          title="Product labels — versioned editor"
          purpose="Full label authoring with structured ingredients, allergens, warnings, storage, route, regulatory class, image/document hash, and label version + verification date. Verified versions become immutable; corrections open a new version."
          bullets={[
            "Manufacturer + exact product name + brand",
            "Product form, serving size, structured ingredients (amount + unit)",
            "Other ingredients, allergens & warnings, directions, storage",
            "SKU, UPC, route, regulatory classification, country/market",
            "Official manufacturer source URL and label sha256 + date/version",
            "Unknown stays Unknown; nothing is inferred from a product name",
            "Data entry, verification, restriction review, and clinical approval remain separate actions",
          ]}
        />
      )}
      {tab === "references" && (
        <ComingIn9EA2Panel
          title="Knowledge references — structured citation review"
          purpose="Reference-level review with claim/subject, source and exact provenance, author/organization, publication date, citation URL/identifier, evidence grade, jurisdiction, reviewer status, warnings and restricted flags. Practitioner-authored material without an external citation reads Practitioner experience — never evidence-based."
          bullets={[
            "Claim or subject; source and exact provenance",
            "Author/organization; publication or label date/version",
            "Citation URL or identifier; evidence grade",
            "Clinical domain and jurisdiction",
            "Reviewer identity, review status, warnings, restricted flags",
            "Practitioner experience label for uncitated material",
            "Dose text stays unverified reference metadata until an exact label backs it",
          ]}
        />
      )}
      {tab === "commercial" && (
        <ComingIn9EA2Panel
          title="Commercial matching queue"
          purpose="Practitioner UI for attaching commercial candidates (affiliate URL, discount code, disclosure) to independently verified clinical product identities. The RPC and acceptance suite for this ship in Phase 9E-A.1; the queue view lands here in 9E-A.2."
          bullets={[
            "Exact SKU / UPC / manufacturer + name match only — never fuzzy",
            "Human decision + stated reason on every attach",
            "Storage in product_label_commercial_links only; no clinical field is touched",
            "Awaiting verified product identity for candidates with no match",
            "Revocation via supersedes_id — the original attach stays for audit",
            "Never exposed to eligibility, safety, evidence, interaction, ranking, reasoning, or protocol code paths",
          ]}
        />
      )}
      {tab === "provenance" && <ProvenancePanel />}
    </div>
  );
}
