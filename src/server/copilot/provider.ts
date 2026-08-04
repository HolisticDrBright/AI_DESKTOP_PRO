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
