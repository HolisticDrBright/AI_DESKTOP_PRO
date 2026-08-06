import { NextRequest } from "next/server";
import { AdapterError } from "@/adapters/errors";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";
import { clinicalRpc } from "@/adapters/supabase-rest.server";
import { getClinicalAccessToken } from "@/adapters/session.server";
import { resolveOrgId } from "@/adapters/config";
import { adaptForPreview, HandoffPackageError, parseHandoffPackage } from "@/server/prh/parse";
import { describeRuntimePosture } from "@/server/runtime/posture";

/**
 * POST — Research Handoff preview upload.
 *
 * Reads only the four files the practitioner explicitly selected in the
 * form: manifest + 3 JSONLs. Validates them against the manifest's
 * declared hashes, counts, and shape. Refuses the entire package on any
 * mismatch. Delegates the atomic 3-batch creation to the
 * `preview_research_handoff` RPC under the caller's practitioner JWT.
 *
 * Never invokes an external service. Never writes raw content to disk.
 * Never logs prompts, PHI, or file bodies. Failure envelopes carry only
 * PHI-safe categories.
 */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      throw new AdapterError("invalid", "invalid_multipart");
    }

    const attest = String(form.get("attestNoPhi") ?? "").toLowerCase() === "true";
    if (!attest) throw new AdapterError("invalid", "attestation_required");

    const readFile = (name: string) => {
      const f = form.get(name);
      if (!(f instanceof File)) throw new AdapterError("invalid", `missing_${name}`);
      return f;
    };
    const manifestFile = readFile("manifest");
    const clinicalFile = readFile("clinical");
    const commercialFile = readFile("commercial");
    const evidenceFile = readFile("evidence");

    const toBytes = async (f: File) => new Uint8Array(await f.arrayBuffer());
    const [mbytes, cbytes, xbytes, ebytes] = await Promise.all([
      toBytes(manifestFile),
      toBytes(clinicalFile),
      toBytes(commercialFile),
      toBytes(evidenceFile),
    ]);

    let parsed;
    try {
      parsed = parseHandoffPackage({
        manifest: { filename: manifestFile.name, bytes: mbytes },
        clinical: { filename: clinicalFile.name, bytes: cbytes },
        commercial: { filename: commercialFile.name, bytes: xbytes },
        evidence: { filename: evidenceFile.name, bytes: ebytes },
      });
    } catch (e) {
      if (e instanceof HandoffPackageError) {
        throw new AdapterError("invalid", e.category);
      }
      throw new AdapterError("invalid", "parse_failed");
    }

    const session = await getRequestSession();
    const token = await getClinicalAccessToken(session.token);
    const orgId = resolveOrgId(session.orgId);

    const clinicalItems = adaptForPreview("clinical", parsed.clinical.items);
    const evidenceItems = adaptForPreview("evidence", parsed.evidence.items);
    const commercialItems = adaptForPreview("commercial", parsed.commercial.items);

    const result = await clinicalRpc<{
      ok: true;
      manifestSha256: string;
      clinical: { batchId: string; itemCount: number; idempotent: boolean };
      evidence: { batchId: string; itemCount: number; idempotent: boolean };
      commercial: { batchId: string; itemCount: number; idempotent: boolean };
    }>(
      "preview_research_handoff",
      {
        _organization_id: orgId,
        _attests_no_phi: true,
        _manifest_sha256: parsed.manifestSha256,
        _clinical_source_name: parsed.clinical.source_name,
        _clinical_source_filename: parsed.clinical.source_filename,
        _clinical_source_byte_size: parsed.clinical.source_byte_size,
        _clinical_items: clinicalItems,
        _evidence_source_name: parsed.evidence.source_name,
        _evidence_source_filename: parsed.evidence.source_filename,
        _evidence_source_byte_size: parsed.evidence.source_byte_size,
        _evidence_items: evidenceItems,
        _commercial_source_name: parsed.commercial.source_name,
        _commercial_source_filename: parsed.commercial.source_filename,
        _commercial_source_byte_size: parsed.commercial.source_byte_size,
        _commercial_items: commercialItems,
      },
      token,
    );

    return {
      ok: true,
      manifestSha256: parsed.manifestSha256,
      clinical: result.clinical,
      evidence: result.evidence,
      commercial: result.commercial,
      aggregates: parsed.aggregates,
      // Runtime posture proves the response came from the real PostgREST
      // RPC on the expected project — never the anon key, JWT, cookie, or
      // practitioner identity. If `transport` is not `postgrest`, the batch
      // IDs shown by the UI did NOT persist to real staging.
      posture: describeRuntimePosture(),
      message:
        "Research Handoff preview complete. Nothing has been verified, approved, activated, or attached.",
    };
  });
}
