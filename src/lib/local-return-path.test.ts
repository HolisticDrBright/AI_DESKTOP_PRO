import { describe, expect, it } from "vitest";
import { afterSignInPath, localReturnPath } from "./local-return-path";

describe("local post-authentication return paths", () => {
  it.each([null, "", "https://elsewhere.invalid", "javascript:alert(1)", "//elsewhere.invalid",
    "/\\elsewhere.invalid", "/\t/elsewhere.invalid", "/%5celsewhere.invalid", "/%2felsewhere.invalid",
    "/%0a/elsewhere.invalid", "/path/..//elsewhere.invalid", "/path/%2e%2e//elsewhere.invalid",
    "/broken%", "/" + "a".repeat(2048)])("refuses %s", value => {
    expect(localReturnPath(value)).toBe("/");
    expect(localReturnPath(value, "/patients")).toBe("/patients");
  });
  it.each(["/", "/today", "/patients/fixture/labs?view=reasoning#result", "/calendar?view=week"])("preserves %s", value => {
    expect(localReturnPath(value)).toBe(value);
  });
});

describe("afterSignInPath", () => {
  it("routes by the server's clinic step and keeps the return path only through an explicit choice", () => {
    expect(afterSignInPath("onboard", "/patients")).toBe("/apply");
    expect(afterSignInPath("choose", "/patients?tab=1")).toBe("/select-clinic?next=%2Fpatients%3Ftab%3D1");
    expect(afterSignInPath("unknown", "/")).toBe("/select-clinic?next=%2F");
    expect(afterSignInPath("selected", "/patients")).toBe("/patients");
    // The legacy default reports no step; anything unrecognised is treated as no step.
    expect(afterSignInPath(undefined, "/patients")).toBe("/patients");
    expect(afterSignInPath("operator", "/patients")).toBe("/patients");
  });
});
