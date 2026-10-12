import { describe, expect, it } from "vitest";
import { createOwnedAskAlpContextLoader } from "./aws-ask-alp-trusted-context";
import type { createOwnedConsumerRecordsAdapter } from "./owned-consumer-records";
import type { ProductionClinicalRequestContext } from "./aws-identity-consent";

const identity: ProductionClinicalRequestContext = {
  actorPersonId: "22222222-2222-4222-8222-222222222222",
  organizationId: "33333333-3333-4333-8333-333333333333",
  identitySubject: "production-user-123", identityPool: "consumer", purpose: "clinical_data",
  environment: "production-clinical", dataClassification: "clinical_phi",
  containsPhi: true, realPatientData: true, productionBound: true,
};

describe("owned Ask ALP context lease", () => {
  it("loads only the server-owned context and rechecks the same consent before delivery", async () => {
    let revision: number | null = 7;
    const adapter = () => ({
      consentState: async () => ({ activeRevision: revision }),
    }) as unknown as ReturnType<typeof createOwnedConsumerRecordsAdapter>;
    const loader = createOwnedAskAlpContextLoader({ adapter, allowedScopes: ["ai_context"] });
    const lease = await loader(identity);
    expect(lease.context).toMatchObject({ labs: [], profile: null, protocol: null, cycle: null });
    await expect(lease.assertCurrent()).resolves.toBeUndefined();
    revision = null;
    await expect(lease.assertCurrent()).rejects.toMatchObject({ code: "consent_required" });
  });

  it("refuses configuration that cannot read the separately consented AI scope", () => {
    const adapter = () => { throw new Error("must not connect"); };
    expect(() => createOwnedAskAlpContextLoader({ adapter, allowedScopes: [] })).toThrow("ask_alp_context_configuration_invalid");
    expect(() => createOwnedAskAlpContextLoader({ adapter, allowedScopes: ["ai_context", "bogus" as "ai_context"] })).toThrow("ask_alp_context_configuration_invalid");
  });

  it("withholds the answer if the source snapshot changes during generation", async () => {
    let value = 80;
    const adapter = () => ({
      consentState: async (_: unknown, scope: string) => ({ activeRevision: scope === "ai_context" ? 9 : 4 }),
      list: async () => [{ recordId: "44444444-4444-4444-8444-444444444444", receivedAt: "2026-10-01T00:00:00.000Z", payload: { name: "Ferritin", value, unit: "ng/mL", drawnAt: "2026-10-01T00:00:00.000Z" } }],
    }) as unknown as ReturnType<typeof createOwnedConsumerRecordsAdapter>;
    const loader = createOwnedAskAlpContextLoader({ adapter, allowedScopes: ["ai_context", "lab_history"] });
    const lease = await loader(identity);
    expect(JSON.stringify(lease.context)).toContain('"value":80');
    value = 90;
    await expect(lease.assertCurrent()).rejects.toMatchObject({ code: "storage_unavailable" });
  });
});
