import { describe, expect, test } from "vitest";
import {
  APP_EDITIONS,
  DEFAULT_EDITION,
  EditionConfigError,
  isEdition,
  resolveEdition,
} from "./edition.build";

/**
 * The edition resolver is the hinge the whole split turns on: it decides
 * whether a build is allowed to reach real patient data. These tests pin the
 * fail-closed behaviour — an ambiguous edition must never resolve to a guess.
 */
describe("edition resolution", () => {
  test("recognizes exactly the two shipped editions", () => {
    expect(APP_EDITIONS).toEqual(["demo", "clinical"]);
    expect(isEdition("demo")).toBe(true);
    expect(isEdition("clinical")).toBe(true);
    expect(isEdition("staging")).toBe(false);
  });

  test("defaults to the demo edition when nothing is set", () => {
    // The safe default is the one that holds no credentials and calls nothing.
    expect(DEFAULT_EDITION).toBe("demo");
    expect(resolveEdition(undefined, undefined)).toBe("demo");
    expect(resolveEdition("", "")).toBe("demo");
  });

  test("accepts either edition, case- and whitespace-insensitively", () => {
    expect(resolveEdition("clinical")).toBe("clinical");
    expect(resolveEdition("  CLINICAL  ")).toBe("clinical");
    expect(resolveEdition("Demo")).toBe("demo");
  });

  test("refuses an unrecognized edition instead of falling back", () => {
    // Coercing "prod" to demo would ship a product whose data boundary nobody
    // chose. It must fail the build.
    expect(() => resolveEdition("prod")).toThrow(EditionConfigError);
    expect(() => resolveEdition("live")).toThrow(/not a valid edition/);
    expect(() => resolveEdition("bogus")).toThrow(/demo, clinical/);
  });

  test("a locked distribution refuses to build as the other edition", () => {
    // This is the demo repository's hard lock: APP_EDITION=clinical there is a
    // build failure, not a demo binary aimed at real infrastructure.
    expect(() => resolveEdition("clinical", "demo")).toThrow(EditionConfigError);
    expect(() => resolveEdition("clinical", "demo")).toThrow(/locked to the "demo" edition/);
    expect(() => resolveEdition("demo", "clinical")).toThrow(/locked to the "clinical" edition/);
  });

  test("a lock alone selects the edition and agrees with a matching request", () => {
    expect(resolveEdition(undefined, "demo")).toBe("demo");
    expect(resolveEdition("demo", "demo")).toBe("demo");
    expect(resolveEdition("clinical", "clinical")).toBe("clinical");
  });

  test("an invalid lock is itself a configuration error", () => {
    expect(() => resolveEdition("demo", "sandbox")).toThrow(/EDITION_LOCK is "sandbox"/);
  });

  test("NEXT_PUBLIC_USE_LIVE_API cannot influence the edition", () => {
    // The deprecated flag is no longer an input to this function at all. A demo
    // build cannot be turned live by setting it — that is the point of the split.
    expect(resolveEdition(undefined, undefined)).toBe("demo");
    expect(resolveEdition("demo")).toBe("demo");
  });
});
