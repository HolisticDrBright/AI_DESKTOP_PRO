import { describe, expect, it } from "vitest";
import { shouldShowOrgSwitcher } from "./org-switcher-visibility";

describe("OrgSwitcher", () => {
  it("offers the sole organization when the session has none selected", () => {
    expect(shouldShowOrgSwitcher(1, null)).toBe(true);
  });

  it("stays compact after the sole organization is selected", () => {
    expect(shouldShowOrgSwitcher(1, "11111111-1111-4111-8111-111111111111")).toBe(false);
  });

  it("does not render for no memberships and renders for multiple memberships", () => {
    expect(shouldShowOrgSwitcher(0, null)).toBe(false);
    expect(shouldShowOrgSwitcher(2, null)).toBe(true);
  });
});
