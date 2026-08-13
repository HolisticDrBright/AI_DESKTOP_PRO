import { AdapterError } from "@/adapters/errors";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";
import { clinicalRpc, clinicalSelect } from "@/adapters/supabase-rest.server";
import { getClinicalAccessToken } from "@/adapters/session.server";
import { resolveOrgId } from "@/adapters/config";
import { resolveCopilotMode } from "@/server/copilot/provider";
import { resolveProviderRuntime } from "@/server/copilot/provider.runtime";
import { isDeployedRuntime } from "@/server/runtime/deployedRuntime";
import { isContractFixtureAllowed } from "@/server/runtime/contractFixture";
import {
  computeProviderPosture,
  type ActivationFacts,
  type ProviderPosture,
  type RegistryFacts,
  type TransactionFacts,
} from "@/server/copilot/provider-posture";

/**
 * GET — the governed copilot provider posture.
 *
 * This route is what the workspace renders its provider banner from. It
 * returns the SAME `ProviderPosture` shape the server computes internally,
 * so the screen and the audit trail cannot tell two different stories.
 *
 * Three deliberate properties:
 *
 *   1. In disabled mode it returns BEFORE reading the registry, requesting
 *      a secret, or constructing a provider runtime. The absence of those
 *      calls is what browser proof #1 observes.
 *   2. A fixture mode that a deployed runtime refuses surfaces as an
 *      honest refusal, not as a silent downgrade to disabled.
 *   3. Nothing in the response carries a secret, an ARN value, an
 *      authorization header, a prompt, or patient data. Only presence
 *      booleans and governed approval references.
 */
export async function GET() {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async (): Promise<{ posture: ProviderPosture; refusal: string | null }> => {
    // Resolving the mode is itself a refusal point: fixture inside a
    // deployed runtime throws, and that is reported rather than softened.
    let mode: "disabled" | "fixture" | "live";
    try {
      mode = resolveCopilotMode();
    } catch (e) {
      throw new AdapterError(
        "unavailable",
        e instanceof Error ? e.message : "Copilot mode is refused in this runtime.",
      );
    }

    const noTransactions: TransactionFacts = {
      everTransacted: false,
      lastRunStatus: null,
      lastRunAt: null,
      lastFailureCategory: null,
    };

    // (1) Disabled short-circuit. No registry read, no secret request, no
    //     runtime construction. Anything below this line is skipped.
    if (mode === "disabled") {
      return {
        posture: computeProviderPosture({
          mode: "disabled",
          runtimeAvailable: false,
          syntheticPermitted: false,
          registry: null,
          activation: null,
          transactions: noTransactions,
        }),
        refusal: null,
      };
    }

    const session = await getRequestSession();
    const token = await getClinicalAccessToken(session.token);
    const orgId = resolveOrgId(session.orgId);

    const rows = await clinicalSelect<RegistryRow[]>(
      "clinical_copilot_provider_registry",
      new URLSearchParams({
        select:
          "id,provider_name,provider_kind,approved_model_allowlist,approval_reference," +
          "baa_status_reference,retention_mode,processing_region,provider_secret_ref," +
          "revocation_state,expiration_date",
        order: "created_at.desc",
        limit: "1",
      }),
      token,
    );
    const row = Array.isArray(rows) ? rows[0] : undefined;

    let activation: ActivationFacts | null = null;
    if (row?.id) {
      const raw = await clinicalRpc<ActivationRow>(
        "get_copilot_activation",
        { _organization_id: orgId, _provider_id: row.id },
        token,
      );
      activation = toActivationFacts(raw);
    }

    const runtime = resolveProviderRuntime({ mode });

    return {
      posture: computeProviderPosture({
        mode,
        runtimeAvailable: runtime.kind === "live" || mode === "fixture",
        // The SAME predicate the provider layer uses to decide whether a
        // synthetic provider may be selected, so the banner cannot promise
        // deterministic content that the run path will refuse to produce.
        syntheticPermitted: !isDeployedRuntime() && isContractFixtureAllowed(),
        registry: row ? toRegistryFacts(row) : null,
        activation,
        // Phase 10B.1 is readiness-only: no live transaction has been
        // executed, and nothing here may claim otherwise. When 10B.2
        // enables supervised activation this reads the run ledger.
        transactions: noTransactions,
      }),
      refusal: runtime.kind === "live" ? null : (runtime as { refusal: string }).refusal,
    };
  });
}

type RegistryRow = {
  id: string;
  provider_name: string;
  provider_kind: RegistryFacts["providerKind"];
  approved_model_allowlist: string[] | null;
  approval_reference: string | null;
  baa_status_reference: string | null;
  retention_mode: RegistryFacts["retentionMode"];
  processing_region: string | null;
  /** Read only to derive presence. NEVER returned to the client. */
  provider_secret_ref: string | null;
  revocation_state: RegistryFacts["revocationState"];
  expiration_date: string | null;
};

function toRegistryFacts(row: RegistryRow): RegistryFacts {
  return {
    providerName: row.provider_name,
    providerKind: row.provider_kind,
    approvedModelAllowlist: Array.isArray(row.approved_model_allowlist)
      ? row.approved_model_allowlist
      : [],
    approvalReference: row.approval_reference,
    baaStatusReference: row.baa_status_reference,
    retentionMode: row.retention_mode,
    processingRegion: row.processing_region,
    // Presence only. The reference value itself stops here.
    hasSecretRef: typeof row.provider_secret_ref === "string" && row.provider_secret_ref.length > 0,
    revocationState: row.revocation_state,
    expirationDate: row.expiration_date,
  };
}

type ActivationRow = {
  state?: ActivationFacts["state"];
  legalRef?: string | null;
  privacyRef?: string | null;
  clinicalRef?: string | null;
  infraRef?: string | null;
  retentionPosture?: ActivationFacts["retentionPosture"];
  supervisedRunsRequired?: number;
  supervisedRunsCompleted?: number;
};

function toActivationFacts(raw: ActivationRow | null): ActivationFacts | null {
  if (!raw || typeof raw !== "object") return null;
  return {
    state: raw.state ?? "disabled",
    legalRef: raw.legalRef ?? null,
    privacyRef: raw.privacyRef ?? null,
    clinicalRef: raw.clinicalRef ?? null,
    infraRef: raw.infraRef ?? null,
    retentionPosture: raw.retentionPosture ?? "unspecified",
    supervisedRunsRequired: raw.supervisedRunsRequired ?? 25,
    supervisedRunsCompleted: raw.supervisedRunsCompleted ?? 0,
  };
}
