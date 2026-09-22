import { describe, expect, it } from "vitest";

import { errorCode, LOG_SAFE_CODE } from "./log-safe-error";

describe("errorCode", () => {
  it("keeps a code-shaped message", () => {
    expect(errorCode(new Error("catalog_verification_refused:12:4"), "fallback")).toBe("catalog_verification_refused:12:4");
  });
  it("drops driver text that could carry parameter values", () => {
    const driver = new Error('ERROR: duplicate key value violates unique constraint "x" DETAIL: Key (email)=(a@b.test) already exists.');
    expect(errorCode(driver, "production_migration_verification_failed")).toBe("production_migration_verification_failed");
  });
  it("drops a non-error throw", () => {
    expect(errorCode("boom", "qualification_target_failed")).toBe("qualification_target_failed");
    expect(errorCode(undefined, "qualification_target_failed")).toBe("qualification_target_failed");
  });
  it("refuses whitespace, capitals and unbounded length", () => {
    expect(LOG_SAFE_CODE.test("two words")).toBe(false);
    expect(LOG_SAFE_CODE.test("Uppercase")).toBe(false);
    expect(LOG_SAFE_CODE.test("a".repeat(201))).toBe(false);
  });
});
