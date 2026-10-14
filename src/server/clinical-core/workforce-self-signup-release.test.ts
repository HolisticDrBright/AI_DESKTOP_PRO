import { expect, test } from "vitest";
import { WORKFORCE_SELF_SIGNUP_READY } from "./workforce-self-signup-release";

test("public practitioner registration remains blocked until identity binding is reviewed", () => {
  expect(WORKFORCE_SELF_SIGNUP_READY).toBe(false);
});
