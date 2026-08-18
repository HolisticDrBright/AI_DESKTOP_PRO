import { describe, expect, test } from "vitest";
import { safeLongitudinalContext } from "./aws-lab-analysis-api";

const marker = {
  biomarkerId: "11111111-1111-4111-8111-111111111111",
  canonicalName: "Glucose", value: 95, unit: "mg/dl", labMin: 70, labMax: 99,
  functionalMin: 75, functionalMax: 90, status: "suboptimal",
};

describe("AWS longitudinal lab context", () => {
  test("accepts bounded prior panels and an explicit active protocol", () => {
    expect(safeLongitudinalContext({
      incomingPanel: { panelId: "panel-new", panelName: "March panel", testDate: "2026-03-01" },
      priorPanels: [{ panelId: "panel-old", panelName: "January panel", testDate: "2026-01-01", biomarkers: [marker] }],
      activeProtocol: { protocolId: "protocol-1", protocolName: "Plan", version: 2, items: [{ itemId: "item-1", kind: "supplement", name: "Synthetic item" }] },
    })).toMatchObject({ priorPanels: [{ biomarkers: [marker] }], activeProtocol: { version: 2 } });
  });

  test("refuses unknown fields, invalid dates, and non-supplied identifier shapes", () => {
    const base = { incomingPanel: { panelId: "panel-new", panelName: "March panel", testDate: "2026-03-01" }, priorPanels: [], activeProtocol: null };
    expect(() => safeLongitudinalContext({ ...base, unexpected: true })).toThrow("longitudinal_context_invalid");
    expect(() => safeLongitudinalContext({ ...base, incomingPanel: { ...base.incomingPanel, testDate: "tomorrow" } })).toThrow("longitudinal_context_invalid");
    expect(() => safeLongitudinalContext({ ...base, priorPanels: [{ panelId: "old", panelName: "Old", testDate: "2026-01-01", biomarkers: [{ ...marker, biomarkerId: "not-a-uuid" }] }] })).toThrow("longitudinal_context_invalid");
  });
});
