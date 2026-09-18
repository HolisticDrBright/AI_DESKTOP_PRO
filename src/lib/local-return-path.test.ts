import { describe, expect, it } from "vitest";
import { localReturnPath } from "./local-return-path";

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
