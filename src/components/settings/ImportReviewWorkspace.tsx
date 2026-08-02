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

type Tab = "sources" | "parse" | "review" | "catalog" | "provenance";

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

/* ------------------------------------------------------------- catalog */

function CatalogReviewPanel() {
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<unknown>(null);
  const [data, setData] = useState<LiveCatalogReviewQueue | null>(null);
  const [note, setNote] = useState<Record<string, string>>({});
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    setState("loading");
    try {
      setData(await liveClient.catalogReviewQueue());
      setState("ready");
    } catch (e) {
      setError(e);
      setState("error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (productId: string, action: "clear_restriction" | "complete_review") => {
    setMessage("");
    try {
      const result = await liveClient.catalogReviewAction({
        productId,
        action,
        note: (note[productId] ?? "").trim(),
      });
      setMessage(result.message);
      await load();
    } catch (e) {
      setMessage(errText(e));
    }
  };

  if (state === "loading") return <ClinicalLoading label="Reading the catalog review queue…" />;
  if (state === "error") return <PanelError error={error} onRetry={load} />;

  return (
    <div className="flex flex-col gap-4">
      <ClinicalNote>
        Every product here arrived in a file. Until its review is completed it is{" "}
        <strong>not returned by search, not selectable, and not attachable</strong> to a protocol.
        Clearing a restriction is not the same as completing a review, and neither is approval.
      </ClinicalNote>

      {message && (
        <p className="m-0 text-[12.5px] text-subtle" role="status" data-testid="catalog-message">
          {message}
        </p>
      )}

      <Card>
        <CardTitle>
          Waiting for review · {data?.counts.total ?? 0} ({data?.counts.restricted ?? 0} restricted)
        </CardTitle>
        {data && data.products.length === 0 ? (
          <p className="m-0 text-[12.5px] text-subtle" data-testid="catalog-empty">
            {data.emptyStateMessage}
          </p>
        ) : (
          <TableWrap>
            <thead>
              <tr>
                <TH>Product</TH>
                <TH>State</TH>
                <TH>Why it cannot be used</TH>
                <TH>Missing facts</TH>
                <TH>Decision</TH>
              </tr>
            </thead>
            <tbody>
              {data?.products.map((p) => (
                <tr key={p.productId} data-testid="catalog-row">
                  <TD>
                    <span className="font-semibold">{p.name}</span>
                    <span className="block text-[11px] text-subtle">
                      {p.brand ?? "Unknown brand"} · {p.sku ?? "no SKU"} ·{" "}
                      {p.sourceFileName ?? "Unknown file"}
                    </span>
                  </TD>
                  <TD>
                    <span className="flex flex-col gap-1">
                      <Chip tone={p.selectable ? "ok" : "warn"}>{p.status}</Chip>
                      {p.restrictedFlags.length > 0 && (
                        <span className="flex flex-wrap gap-1">
                          {p.restrictedFlags.map((f) => (
                            <Chip key={f} tone="danger">
                              {f}
                            </Chip>
                          ))}
                        </span>
                      )}
                    </span>
                  </TD>
                  <TD className="max-w-[320px] text-[11.5px]" data-testid="catalog-block-reason">
                    {p.blockReason ?? "Nothing is blocking this product."}
                  </TD>
                  <TD className="text-[11.5px]" data-testid="catalog-missing">
                    {p.missingFacts.length === 0 ? (
                      "—"
                    ) : (
                      <>
                        {p.missingFacts.join(", ")}
                        {p.status === "incomplete" && (
                          <span
                            className="mt-1 block text-warning-deep"
                            data-testid="catalog-incomplete-note"
                          >
                            This product cannot complete its review until these facts are
                            recorded. The source did not supply them, and this system will not
                            supply them for it.
                          </span>
                        )}
                      </>
                    )}
                  </TD>
                  <TD>
                    <TextInput
                      value={note[p.productId] ?? ""}
                      onChange={(e) => setNote({ ...note, [p.productId]: e.target.value })}
                      placeholder="Stated reason"
                      aria-label={`Reason for ${p.name}`}
                      data-testid="catalog-note"
                    />
                    <div className="mt-1 flex gap-2">
                      {p.restrictedFlags.length > 0 && !p.restrictedClearedAt && (
                        <Btn
                          variant="ghost"
                          onClick={() => act(p.productId, "clear_restriction")}
                          disabled={!(note[p.productId] ?? "").trim()}
                          data-testid="clear-restriction"
                        >
                          Clear restriction
                        </Btn>
                      )}
                      {/* An `incomplete` product is refused by the database,
                          and that refusal arrives as an opaque conflict — this
                          boundary deliberately does not pass database messages
                          through. So the surface explains it from STRUCTURED
                          data instead, and does not offer the action at all. */}
                      <Btn
                        variant="ghost"
                        onClick={() => act(p.productId, "complete_review")}
                        disabled={
                          !(note[p.productId] ?? "").trim() || p.status === "incomplete"
                        }
                        data-testid="complete-review"
                      >
                        Complete review
                      </Btn>
                    </div>
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

export function ImportReviewWorkspace() {
  const [tab, setTab] = useState<Tab>("sources");
  const [batchId, setBatchId] = useState<string | null>(null);

  const tabs = useMemo(
    () =>
      [
        { id: "sources", label: "Source files" },
        { id: "parse", label: "Read a file" },
        { id: "review", label: "Review batch" },
        { id: "catalog", label: "Catalog review" },
        { id: "provenance", label: "Provenance" },
      ] as Array<{ id: Tab; label: string }>,
    [],
  );

  return (
    <div className="flex flex-col gap-4">
      {/* A local tablist rather than the URL-synced SegTabs: the open batch is
          client state, and a deep link to a tab whose batch is gone would show
          an empty panel that reads like an empty import. */}
      <div role="tablist" aria-label="Import review sections" className="flex flex-wrap gap-1">
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
      {tab === "sources" && <SourcesPanel />}
      {tab === "parse" && (
        <ParsePanel
          onStaged={(id) => {
            setBatchId(id);
            setTab("review");
          }}
        />
      )}
      {tab === "review" && <ReviewPanel batchId={batchId} />}
      {tab === "catalog" && <CatalogReviewPanel />}
      {tab === "provenance" && <ProvenancePanel />}
    </div>
  );
}
