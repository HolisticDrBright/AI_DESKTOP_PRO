import { NextRequest } from "next/server";
import { protocolsLive } from "@/adapters/protocols.live";
import {
  ProtocolCopilotDisabledError,
  draftProtocolFromTemplate,
} from "@/server/protocol-copilot";
import { AdapterError } from "@/adapters/errors";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

/**
 * POST — draft protocol suggestions from an approved template.
 *
 * Reads only. The route fetches governed inputs, hands them to a deterministic
 * assembler, and returns labelled draft suggestions. Nothing is saved,
 * approved, activated, ordered or charged, and no commercial data is fetched or
 * passed in — the assembler has no field that could receive it.
 */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    if (typeof b.patientId !== "string" || !b.patientId) {
      throw new AdapterError("invalid", "patientId is required");
    }
    if (typeof b.versionId !== "string" || !b.versionId) {
      throw new AdapterError("invalid", "versionId is required");
    }
    const session = await getRequestSession();

    const patientProtocol = await protocolsLive.getPatientProtocol(
      b.patientId,
      session.orgId,
      session.token,
    );

    // Only versions that carry their items can be drafted from. History
    // entries are summaries and do not, so asking for one is a not-found
    // rather than a draft assembled from a version whose contents we guessed.
    const version = [patientProtocol.draft, patientProtocol.approved].find(
      (v) => v != null && v.id === b.versionId,
    );
    if (!version) throw new AdapterError("not_found");

    try {
      return draftProtocolFromTemplate({
        templateName: version.title ?? "this protocol",
        templateVersion: version.version ?? 1,
        items: (version.items ?? []).map((item, index) => ({
          position: item.position ?? index,
          kind: item.kind as
            | "product"
            | "diet"
            | "lifestyle"
            | "monitoring"
            | "followup",
          label: item.label,
          // Never defaulted. A missing dose stays missing.
          dosageText: item.dosageText ?? null,
          doseSourceKind: null,
          doseSourceRef: null,
          catalogProductVersionId: item.catalogProductVersionId ?? null,
          verificationStatus: item.verificationStatus ?? null,
          interventionClassCode: null,
        })),
        // Governed intervention classes are platform content and none is
        // loaded yet; an empty list means no monitoring or stopping rule is
        // asserted, which is the honest state rather than a silent omission.
        interventionClasses: [],
        patient: {
          allergies: [],
          medications: [],
          medicationsHaveCodedIdentifiers: false,
        },
        governedInteractionReferenceLoaded: false,
      });
    } catch (e) {
      // A deliberately disabled boundary is UNAVAILABLE, not a crash. Reporting
      // it as 500 would read as a fault and invite a retry; the honest answer
      // is that the copilot is off, and why.
      if (e instanceof ProtocolCopilotDisabledError) {
        throw new AdapterError(
          "unavailable",
          `${e.message} ${e.problems.join(" ")}`.trim(),
        );
      }
      throw e;
    }
  });
}
