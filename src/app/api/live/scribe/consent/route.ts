import { NextRequest } from "next/server";
import { scribeLive, type ConsentMethod, type ConsentScope } from "@/adapters/scribe.live";
import { AdapterError } from "@/adapters/errors";
import { getRequestSession } from "@/server/session";
import { resolveOrgId } from "@/adapters/config";
import { liveGuard, runLive } from "../../route-helpers";

const SCOPES: ConsentScope[] = ["recording", "transcription", "ai_drafting"];
const METHODS: ConsentMethod[] = ["verbal_attested", "written", "electronic_signature"];
const KINDS = ["patient", "caregiver", "practitioner", "other"] as const;
const REP_BASES = ["minor_guardian", "legal_authorized_representative", "surrogate_unable_to_consent"];

/**
 * GET ?encounterId= → participants + per-scope consent state, and the active
 * consent documents for the caller's organization (the exact versioned
 * artifact the UI must present before recording).
 */
export async function GET(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const encounterId = req.nextUrl.searchParams.get("encounterId");
    if (!encounterId) throw new AdapterError("invalid", "An encounter is required.");
    const session = await getRequestSession();
    const orgId = resolveOrgId(session.orgId);
    const [participants, documents, provider] = await Promise.all([
      scribeLive.participants(encounterId, session.token),
      scribeLive.consentDocuments(orgId, session.token),
      scribeLive.providerStatus(session.token),
    ]);
    return { participants, documents, provider };
  });
}

/** POST { action: addParticipant | recordConsent | withdrawConsent, ... } */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const action = typeof body.action === "string" ? body.action : "";
    const session = await getRequestSession();

    if (action === "addParticipant") {
      const encounterId = typeof body.encounterId === "string" ? body.encounterId : "";
      const kind = typeof body.kind === "string" ? body.kind : "";
      const displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";
      const relationship =
        typeof body.relationship === "string" && body.relationship ? body.relationship : undefined;
      const canSelfConsent = body.canSelfConsent !== false;
      if (!encounterId) throw new AdapterError("invalid", "An encounter is required.");
      if (!(KINDS as readonly string[]).includes(kind)) throw new AdapterError("invalid", "Choose a participant type.");
      if (!displayName) throw new AdapterError("invalid", "A participant name is required.");
      return scribeLive.addParticipant(
        { encounterId, kind: kind as (typeof KINDS)[number], displayName, relationship, canSelfConsent },
        session.token,
      );
    }

    if (action === "recordConsent") {
      const participantId = typeof body.participantId === "string" ? body.participantId : "";
      const scope = typeof body.scope === "string" ? body.scope : "";
      const consentDocumentId = typeof body.consentDocumentId === "string" ? body.consentDocumentId : "";
      const method = typeof body.method === "string" ? body.method : "";
      const signerAcknowledgment =
        typeof body.signerAcknowledgment === "string" ? body.signerAcknowledgment.trim() : "";
      const jurisdiction = typeof body.jurisdiction === "string" && body.jurisdiction ? body.jurisdiction : undefined;
      if (!participantId) throw new AdapterError("invalid", "A participant is required.");
      if (!SCOPES.includes(scope as ConsentScope)) throw new AdapterError("invalid", "Choose a consent scope.");
      if (!consentDocumentId) throw new AdapterError("invalid", "A consent document is required.");
      if (!METHODS.includes(method as ConsentMethod)) throw new AdapterError("invalid", "Choose a consent method.");
      if (!signerAcknowledgment) throw new AdapterError("invalid", "A signer acknowledgment is required.");

      let representative: { name: string; relationship?: string; basis: string; authority: string } | undefined;
      const rep = body.representative as Record<string, unknown> | undefined;
      if (rep && typeof rep === "object") {
        const name = typeof rep.name === "string" ? rep.name.trim() : "";
        const basis = typeof rep.basis === "string" ? rep.basis : "";
        const authority = typeof rep.authority === "string" ? rep.authority.trim() : "";
        const relationship = typeof rep.relationship === "string" && rep.relationship ? rep.relationship : undefined;
        if (!name || !authority || !REP_BASES.includes(basis)) {
          throw new AdapterError(
            "invalid",
            "Representative consent needs the representative's name, legal basis, and authority.",
          );
        }
        representative = { name, relationship, basis, authority };
      }
      return scribeLive.recordConsent(
        {
          participantId,
          scope: scope as ConsentScope,
          consentDocumentId,
          method: method as ConsentMethod,
          signerAcknowledgment,
          jurisdiction,
          representative,
        },
        session.token,
      );
    }

    if (action === "withdrawConsent") {
      const consentId = typeof body.consentId === "string" ? body.consentId : "";
      const reason = typeof body.reason === "string" && body.reason ? body.reason : undefined;
      if (!consentId) throw new AdapterError("invalid", "A consent record is required.");
      return scribeLive.withdrawConsent({ consentId, reason }, session.token);
    }

    throw new AdapterError("invalid", "Unknown consent action.");
  });
}
