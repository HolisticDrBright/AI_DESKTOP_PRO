import { describe, expect, test } from "vitest";
import {
  isProductionPilotCollectionAllowed,
  isProductionPilotConsentScopeAllowed,
  isProductionPilotScope,
} from "./production-pilot-policy";

describe("production pilot policy", () => {
  test("keeps the current lab/intake pilot away from wearable and cycle records", () => {
    expect(isProductionPilotCollectionAllowed("lab_intake_only", "clinical_intakes")).toBe(true);
    expect(isProductionPilotCollectionAllowed("lab_intake_only", "wearable_daily_records")).toBe(false);
    expect(isProductionPilotCollectionAllowed("lab_intake_only", "hormone_entries")).toBe(false);
    expect(isProductionPilotConsentScopeAllowed("lab_intake_only", "reproductive_health")).toBe(false);
  });

  test("the expanded candidate requires explicit narrow wearable and reproductive scopes", () => {
    expect(isProductionPilotScope("lab_intake_wearables_cycle_ai")).toBe(true);
    expect(isProductionPilotCollectionAllowed("lab_intake_wearables_cycle_ai", "wearable_daily_records")).toBe(true);
    expect(isProductionPilotCollectionAllowed("lab_intake_wearables_cycle_ai", "hormone_entries")).toBe(true);
    expect(isProductionPilotCollectionAllowed("lab_intake_wearables_cycle_ai", "protocols")).toBe(false);
    expect(isProductionPilotConsentScopeAllowed("lab_intake_wearables_cycle_ai", "reproductive_health")).toBe(true);
    expect(isProductionPilotConsentScopeAllowed("lab_intake_wearables_cycle_ai", "billing_links")).toBe(false);
  });
});
