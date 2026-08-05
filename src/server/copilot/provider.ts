/**
 * Phase 10A — vendor-neutral clinical copilot provider abstraction.
 *
 * SERVER-ONLY. Never import from client code. Enforced by module guard.
 */
if (typeof window !== "undefined") {
  throw new Error("copilot/provider is server-only and must not run in the browser.");
}

import { isDeployedRuntime } from "../runtime/deployedRuntime";
import { isContractFixtureAllowed } from "../runtime/contractFixture";
export { isDeployedRuntime as isDeployedEnvironment };

export type CopilotMode = "disabled" | "fixture" | "live";

export type CopilotRunType =
  | "longitudinal_brief"
  | "differential_questions"
  | "lab_suggestions"
  | "protocol_draft"
  | "practitioner_brief";

export type CopilotDraftOutput = {
  runType: CopilotRunType;
  content: Record<string, unknown>;
  citations: Array<{
    citationType: "knowledge_reference" | "product_label" | "protocol_template" | "diet_template";
    refId: string;
    version: string | null;
  }>;
  contentSha256: string;
  providerName: string;
  providerModel: string | null;
};

export interface CopilotProvider {
  readonly name: string;
  readonly model: string | null;
  draft(input: {
    runType: CopilotRunType;
    lens: string;
    inputSnapshot: Record<string, unknown>;
    allowedCitationIds: ReadonlySet<string>;
  }): Promise<CopilotDraftOutput>;
}

/**
 * Read the mode from the server-side env. Deployed environments (production
 * or preview) REFUSE the fixture provider — the mode has to be `disabled`
 * (default) or `live` (which is itself refused until Phase 10B ships an
 * approved provider), never `fixture`.
 *
 * The env-flag alone is not evidence of legal/privacy/clinical approval:
 * see `providerApprovalRef` on the run row for the approval receipt.
 */
export function resolveCopilotMode(): CopilotMode {
  const raw = (process.env.CLINICAL_COPILOT_MODE ?? "disabled").toLowerCase();
  const mode: CopilotMode = raw === "fixture" ? "fixture" : raw === "live" ? "live" : "disabled";
  if (mode === "fixture" && isDeployedRuntime()) {
    // Deployed environments REFUSE fixture mode — no exception; the process
    // must be reconfigured. An env flag alone can never opt a deployed
    // process back in. See src/server/runtime/deployedRuntime.ts for the
    // shared multi-platform posture detector.
    throw new Error(
      "CLINICAL_COPILOT_MODE=fixture is refused in a deployed environment. " +
        "Fixture mode is for local + CI tests only.",
    );
  }
  return mode;
}


/**
 * Disabled provider — the default. Every call returns an "unavailable"
 * draft that the workspace surfaces honestly. It never contacts any
 * external service.
 */
export const disabledProvider: CopilotProvider = {
  name: "disabled",
  model: null,
  async draft() {
    // Even when the mode is disabled, the RUN still records its unavailable
    // state so the audit trail is honest. This return value is what the
    // workspace renders.
    throw new CopilotUnavailable("clinical copilot is disabled");
  },
};

export class CopilotUnavailable extends Error {
  readonly kind = "unavailable" as const;
  constructor(message = "copilot unavailable") {
    super(message);
    this.name = "CopilotUnavailable";
  }
}

/**
 * The fixture provider is loaded lazily so its bytes never end up in a
 * production bundle. Tests select it explicitly via CLINICAL_COPILOT_MODE.
 */
async function loadFixtureProvider(): Promise<CopilotProvider> {
  if (isDeployedRuntime()) {
    throw new Error("fixture provider refused in a deployed environment");
  }
  const mod = await import("./provider.fixture");
  return mod.fixtureProvider;
}

/**
 * The live provider adapter is a scaffold only — it MUST refuse in Phase
 * 10A. Phase 10B replaces this body after legal + privacy + clinical +
 * infra sign-off.
 */
const liveProvider: CopilotProvider = {
  name: "live",
  model: null,
  async draft() {
    throw new CopilotUnavailable(
      "live copilot provider is not activated in Phase 10A. " +
        "Activation requires legal, privacy, clinical, and infra sign-off.",
    );
  },
};

export async function selectProvider(): Promise<CopilotProvider> {
  const mode = resolveCopilotMode();
  if (mode === "fixture") return loadFixtureProvider();
  if (mode === "live") return liveProvider;
  return disabledProvider;
}

/**
 * Governed provider selection.
 *
 * A governed record is necessary for the synthetic path but NOT sufficient.
 * An earlier revision treated `approved_for_synthetic` as authority enough
 * to run a fixture inside a deployed runtime, on the reasoning that an
 * audited DB row outranks an env flag. That was rejected, and rightly: a
 * row in a table is not a reason for synthetic clinical content to exist
 * in a deployed process at all. The blast radius of a mis-set activation
 * row is a patient chart showing invented content that looks real.
 *
 * So the deployed refusal is CATEGORICAL and comes first, matching Phase
 * 10A exactly. On top of it, the synthetic path additionally requires the
 * isolated local contract-fixture boundary to pass — explicit opt-in, a
 * loopback backend, and not the clinical project.
 *
 * All six conditions must hold together:
 *
 *   1. the process-level mode is `live` (never `disabled`);
 *   2. `isDeployedRuntime()` is FALSE — no exceptions, no governed record
 *      can override it;
 *   3. the contract-fixture boundary allows (see
 *      `runtime/contractFixture.ts`);
 *   4. the registered provider kind is literally `synthetic_fixture`;
 *   5. the organization's activation state is `approved_for_synthetic`;
 *   6. the input carries no PHI.
 *
 * Any of those missing falls through to `liveProvider`, which refuses.
 * There is no path that produces synthetic content for an organization
 * that did not record the decision to accept it, no path that produces it
 * in a deployed runtime at all, and no path that lets synthetic content
 * stand in for a failed live call — `approved_for_synthetic` and
 * `approved_for_phi` are different states and the second never selects a
 * fixture.
 */
export async function selectGovernedProvider(input: {
  registryKind: string | null;
  registryName?: string | null;
  activationState: string | null;
  containsPHI: boolean;
  mode?: CopilotMode;
}): Promise<CopilotProvider> {
  const mode = input.mode ?? resolveCopilotMode();
  if (mode === "disabled") return disabledProvider;
  if (mode === "fixture") return loadFixtureProvider();

  // A deployed runtime never gets a synthetic provider, whatever the
  // governed records say. This check is first so no later condition can be
  // read as an exception to it.
  const syntheticPermittedHere = !isDeployedRuntime() && isContractFixtureAllowed();

  const syntheticApproved =
    syntheticPermittedHere &&
    input.registryKind === "synthetic_fixture" &&
    input.activationState === "approved_for_synthetic" &&
    input.containsPHI === false;

  if (syntheticApproved) {
    const mod = await import("./provider.fixture");
    if (input.registryName === ADVERSARIAL_SYNTHETIC_NAME) {
      return adversarialSyntheticProvider(mod.fixtureProvider);
    }
    return {
      ...mod.fixtureProvider,
      // Named for what it is on every run row and every screen, so a
      // synthetic draft can never be mistaken for a live one in the audit
      // trail.
      name: "fixture:governed-synthetic",
    };
  }
  return liveProvider;
}

/**
 * The registry `provider_name` that selects the adversarial synthetic
 * provider. It is a governed identity like any other: a platform admin has
 * to register it, and the organization has to be in
 * `approved_for_synthetic` for it to be reachable at all.
 */
export const ADVERSARIAL_SYNTHETIC_NAME = "synthetic_fixture_adversarial";

/**
 * A synthetic provider that deliberately emits one citation OUTSIDE the
 * governed retrieval envelope.
 *
 * This exists so the hallucinated-citation guard is provable through the
 * real UI and the real persistence path, not only in a unit test. The
 * ordinary fixture provider cites only from the allowed set by
 * construction, which means the rejection branch — the one that actually
 * matters — would otherwise never execute in a browser run.
 *
 * It is bounded exactly as the ordinary synthetic provider is: never in a
 * deployed runtime, only behind the local contract-fixture boundary, only
 * under `approved_for_synthetic`, only with no PHI present, and labelled
 * distinctly on the run row.
 */
function adversarialSyntheticProvider(base: CopilotProvider): CopilotProvider {
  return {
    name: "fixture:governed-synthetic-adversarial",
    model: base.model,
    async draft(args) {
      const out = await base.draft(args);
      return {
        ...out,
        providerName: "fixture:governed-synthetic-adversarial",
        citations: [
          ...out.citations,
          {
            citationType: "knowledge_reference" as const,
            // Not in any retrieval envelope, by construction.
            refId: "hallucinated-reference-not-in-envelope",
            version: null,
          },
        ],
      };
    },
  };
}
