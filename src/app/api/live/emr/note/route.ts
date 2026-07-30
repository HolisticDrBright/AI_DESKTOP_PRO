import { NextRequest } from "next/server";
import { encountersLive, type NoteType, type ProvenanceRef } from "@/adapters/encounters.live";
import { AdapterError } from "@/adapters/errors";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

const NOTE_TYPES = ["soap", "narrative", "follow_up", "adime", "patient_instructions"];
const PROV_TYPES = [
  "appointment", "encounter", "lab_observation", "lab_document",
  "patient_form", "chart_item", "practitioner_entered", "transcript",
  "differential_question", "lens_evaluation",
];
const MAX_REQUEST_BODY = 384 * 1024;
const MAX_NOTE_CONTENT = 256 * 1024;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

/** GET ?noteId= → authoritative note detail (composer load + recovery). */
export async function GET(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const noteId = req.nextUrl.searchParams.get("noteId");
    if (!noteId || !UUID.test(noteId)) throw new AdapterError("invalid", "A valid note is required.");
    const session = await getRequestSession();
    return encountersLive.getNote(noteId, session.token);
  });
}

/**
 * POST — save a draft (autosave or manual). Optimistic concurrency: the
 * server refuses stale expectedVersion with 409/conflict, which the composer
 * turns into the side-by-side conflict view. "Saved" is only shown after
 * this returns 200.
 */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const len = Number(req.headers.get("content-length") ?? "0");
    if (Number.isFinite(len) && len > MAX_REQUEST_BODY) {
      throw new AdapterError("invalid", "This note is too large to save.");
    }
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const encounterId = typeof body.encounterId === "string" ? body.encounterId : "";
    const noteType = typeof body.noteType === "string" ? body.noteType : "";
    const expectedVersion = Number(body.expectedVersion);
    const noteId = typeof body.noteId === "string" && body.noteId ? body.noteId : undefined;
    const saveKind = body.saveKind === "manual" ? "manual" : "autosave";

    if (!UUID.test(encounterId)) throw new AdapterError("invalid", "A valid encounter is required.");
    if (noteId && !UUID.test(noteId)) throw new AdapterError("invalid", "A valid note is required.");
    if (!NOTE_TYPES.includes(noteType)) throw new AdapterError("invalid", "Choose a valid note type.");
    if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
      throw new AdapterError("invalid", "A valid version is required.");
    }
    const rawContent = body.content;
    if (!rawContent || typeof rawContent !== "object" || Array.isArray(rawContent)) {
      throw new AdapterError("invalid", "Note content is required.");
    }
    const content: Record<string, string> = {};
    const contentEntries = Object.entries(rawContent as Record<string, unknown>);
    if (contentEntries.length > 32) {
      throw new AdapterError("invalid", "This note has too many sections.");
    }
    for (const [k, v] of contentEntries) {
      if (!k || k.length > 60) throw new AdapterError("invalid", "A note section is invalid.");
      if (typeof v !== "string") throw new AdapterError("invalid", "Note sections must be text.");
      content[k] = v;
    }
    if (JSON.stringify(content).length > MAX_NOTE_CONTENT) {
      throw new AdapterError("invalid", "This note is too large to save.");
    }

    const provenance: ProvenanceRef[] = [];
    if (Array.isArray(body.provenance)) {
      if (body.provenance.length > 50) {
        throw new AdapterError("invalid", "This note has too many source references.");
      }
      for (const raw of body.provenance as Record<string, unknown>[]) {
        const sectionKey = typeof raw?.sectionKey === "string" ? raw.sectionKey.trim() : "";
        const refType = typeof raw?.refType === "string" ? raw.refType : "";
        const label = typeof raw?.label === "string" ? raw.label.trim() : "";
        const refId = typeof raw?.refId === "string" && raw.refId ? raw.refId : undefined;
        if (
          !sectionKey || sectionKey.length > 60
          || !label || label.length > 200
          || !PROV_TYPES.includes(refType)
          || (refType !== "practitioner_entered" && (!refId || !UUID.test(refId)))
          || (refType === "practitioner_entered" && refId)
        ) {
          throw new AdapterError("invalid", "A note source reference is invalid.");
        }
        provenance.push({
          sectionKey,
          refType: refType as ProvenanceRef["refType"],
          refId,
          label,
        });
      }
    }

    const session = await getRequestSession();
    return encountersLive.saveNote(
      {
        encounterId,
        noteType: noteType as NoteType,
        content,
        expectedVersion,
        noteId,
        saveKind,
        provenance,
      },
      session.token,
      session.orgId,
    );
  });
}
