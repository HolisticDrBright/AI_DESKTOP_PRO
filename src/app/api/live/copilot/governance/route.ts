import { AdapterError } from "@/adapters/errors";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";
import { clinicalRpc } from "@/adapters/supabase-rest.server";
import { getClinicalAccessToken } from "@/adapters/session.server";
import { resolveOrgId } from "@/adapters/config";
import { STAGING_PROJECT_REF } from "@/server/copilot/staging-gate";
import { GOVERNED_MODELS } from "@/server/copilot/model-allowlist";
import {
  OUTPUT_SCHEMA_NAME,
  REQUEST_CONTRACT_VERSION,
} from "@/server/copilot/provider.openai.request";

/**
 * GET — the AI Governance operator surface.
 *
 * Everything here comes from `get_copilot_governance_view`, which reads
 * governed rows under the caller's RLS session and returns presence
 * booleans rather than values: `hasSecretRef` is a boolean, and the ARN it
 * describes never leaves the server.
 *
 * The three fields this route ADDS are process facts the database cannot
 * know — which project this server is pointed at, which request contract
 * this build speaks, and which models this build can price. Reporting them
 * next to the row data is what lets an operator see a mismatch between
 * "what was approved" and "what is deployed".
 *
 * Nothing here is an approval. A `verified` BAA status means a reviewer
 * recorded a dated reference; it does not mean this application is
 * HIPAA-ready, and no field in this response says that it is.
 */
export async function GET() {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const session = await getRequestSession();
    const token = await getClinicalAccessToken(session.token);
    const view = await clinicalRpc<Record<string, unknown>>(
      "get_copilot_governance_view",
      { _organization_id: resolveOrgId(session.orgId) },
      token,
    );

    const backendUrl = process.env.CLINICAL_SUPABASE_URL ?? "";
    let backendHost = "";
    try {
      backendHost = new URL(backendUrl).hostname;
    } catch {
      backendHost = "";
    }

    return {
      ...view,
      /** Process facts, reported separately from the governed rows. */
      runtime: {
        // Presence of the staging ref only. The full URL is not returned:
        // it is not a secret, but it is also not the operator's business
        // and returning less is free.
        pointedAtStagingProject: backendHost.includes(STAGING_PROJECT_REF),
        backendConfigured: backendHost.length > 0,
        requestContractVersion: REQUEST_CONTRACT_VERSION,
        outputSchemaVersion: OUTPUT_SCHEMA_NAME,
        buildGovernedModels: GOVERNED_MODELS.map((m) => m.id),
      },
      /**
       * Stated flatly and unconditionally, because the surface that shows
       * a green "verified" BAA badge is exactly the surface where someone
       * will conclude the opposite.
       */
      phaseLimits: {
        phase: "10B.2",
        purpose: "Synthetic staging verification only",
        realPatientUseAvailable: false,
        productionActivationAvailable: false,
      },
    };
  });
}

/**
 * POST — engage or release the kill switch.
 *
 * A reason is required in BOTH directions and is enforced server-side by
 * `set_copilot_kill_switch`. Releasing is the more consequential of the
 * two and must not be the cheaper one to do.
 */
export async function POST(req: Request) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    if (typeof b.providerId !== "string" || !b.providerId) {
      throw new AdapterError("invalid", "providerId is required.");
    }
    if (typeof b.engaged !== "boolean") {
      throw new AdapterError("invalid", "engaged must be true or false.");
    }
    if (typeof b.reason !== "string" || b.reason.trim().length < 3) {
      throw new AdapterError(
        "invalid",
        "A reason is required to change the kill switch, in either direction.",
      );
    }
    const session = await getRequestSession();
    const token = await getClinicalAccessToken(session.token);
    return clinicalRpc(
      "set_copilot_kill_switch",
      {
        _organization_id: resolveOrgId(session.orgId),
        _provider_id: b.providerId,
        _engaged: b.engaged,
        _reason: b.reason.trim(),
      },
      token,
    );
  });
}
