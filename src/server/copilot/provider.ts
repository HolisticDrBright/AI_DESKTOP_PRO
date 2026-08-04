/**
 * Phase 10A — vendor-neutral clinical copilot provider abstraction.
 *
 * SERVER-ONLY. Never import from client code. Enforced by module guard.
 */
if (typeof window !== "undefined") {
  throw new Error("copilot/provider is server-only and must not run in the browser.");
}

import { isDeployedRuntime } from "../runtime/deployedRuntime";
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
 * The difference from `selectProvider()` is the source of authority. That
 * function reads an ENV FLAG, which is why it refuses fixture mode in a
 * deployed runtime: an env var is not evidence of anything, and a deployed
 * process must not be able to opt itself back into synthetic content.
 *
 * This function reads GOVERNED RECORDS instead — the provider registry row
 * and the organization's activation row, both of which a platform admin
 * had to write through an audited RPC. The `approved_for_synthetic` state
 * exists in the schema precisely to name "this organization has agreed to
 * evaluate the copilot against deterministic synthetic content".
 *
 * The synthetic path is therefore permitted in a deployed runtime, but
 * only under all four conditions together:
 *
 *   1. the process-level mode is `live` (never `disabled`);
 *   2. the registered provider kind is literally `synthetic_fixture`;
 *   3. the organization's activation state is `approved_for_synthetic`;
 *   4. the input carries no PHI.
 *
 * Any of those missing falls through to `liveProvider`, which refuses.
 * There is no path here that produces synthetic content for an
 * organization that did not record the decision to accept it, and no
 * path that lets synthetic content stand in for a failed live call —
 * `approved_for_synthetic` and `approved_for_phi` are different states and
 * the second never selects the fixture.
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

  const syntheticApproved =
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
 * It is bounded the same way as the ordinary synthetic provider: reachable
 * only under `approved_for_synthetic`, only with no PHI present, and
 * labelled distinctly on the run row.
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
