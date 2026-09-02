import { describe, expect, it } from "vitest";
import {
  isMissingOrganizationMessage,
  safeOrganizationRecoveryPath,
} from "./organization-recovery";

describe("organization recovery", () => {
  it("recognizes the missing-organization clinical error", () => {
    expect(
      isMissingOrganizationMessage(
        "No organization selected. Choose your organization in Settings.",
      ),
    ).toBe(true);
    expect(isMissingOrganizationMessage("The clinical service is unavailable.")).toBe(false);
  });

  it("allows only application-local return paths", () => {
    expect(safeOrganizationRecoveryPath("/calendar?view=week")).toBe("/calendar?view=week");
    expect(safeOrganizationRecoveryPath("https://example.com")).toBe("/patients");
    expect(safeOrganizationRecoveryPath("//example.com")).toBe("/patients");
    expect(safeOrganizationRecoveryPath(null)).toBe("/patients");
  });
});
