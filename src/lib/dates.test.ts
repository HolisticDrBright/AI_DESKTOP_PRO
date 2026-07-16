import { describe, expect, test } from "vitest";
import { calendarAge, displaySex, formatDateOnly, parseDateOnly } from "./dates";

/**
 * P0 demographic accuracy. The unit suite runs with TZ=America/Los_Angeles
 * (see the test:unit script), so any UTC-midnight parsing regression shows up
 * as an off-by-one day here — exactly the bug this replaced.
 */

describe("parseDateOnly / formatDateOnly (Pacific time)", () => {
  test("date-only strings keep their calendar day — no UTC shift", () => {
    expect(process.env.TZ).toBe("America/Los_Angeles");
    // new Date("1990-04-12") in Pacific renders Apr 11 — the old bug.
    expect(formatDateOnly("1990-04-12")).toBe("04/12/1990");
    expect(parseDateOnly("1990-04-12")).toEqual({ y: 1990, m: 4, d: 12 });
  });

  test("January 1st and December 31st never bleed across the year boundary", () => {
    expect(formatDateOnly("2000-01-01")).toBe("01/01/2000");
    expect(formatDateOnly("1999-12-31")).toBe("12/31/1999");
  });

  test("missing or malformed values are honestly absent", () => {
    expect(formatDateOnly(null)).toBe("—");
    expect(formatDateOnly("not-a-date")).toBe("—");
    expect(parseDateOnly("1990-13-40")).toBeNull();
  });
});

describe("calendarAge", () => {
  const today = { y: 2026, m: 7, d: 16 };

  test("whole-year calendar age around the birthday", () => {
    expect(calendarAge("1990-07-16", today)).toBe(36); // birthday today
    expect(calendarAge("1990-07-17", today)).toBe(35); // tomorrow
    expect(calendarAge("1990-07-15", today)).toBe(36); // yesterday
  });

  test("year-boundary birth dates (the UTC-shift hot spot)", () => {
    expect(calendarAge("2000-01-01", today)).toBe(26);
    expect(calendarAge("1999-12-31", today)).toBe(26);
    expect(calendarAge("1999-12-31", { y: 2026, m: 12, d: 30 })).toBe(26);
    expect(calendarAge("1999-12-31", { y: 2026, m: 12, d: 31 })).toBe(27);
  });

  test("unknown birth date is unknown age — never a fabricated 0", () => {
    expect(calendarAge(null, today)).toBeNull();
    expect(calendarAge(undefined, today)).toBeNull();
    expect(calendarAge("garbage", today)).toBeNull();
  });
});

describe("displaySex — recorded value only, never guessed", () => {
  test("all supported states", () => {
    expect(displaySex("female")).toBe("Female");
    expect(displaySex("male")).toBe("Male");
    expect(displaySex("other")).toBe("Other");
    expect(displaySex("unknown")).toBe("Unknown");
    expect(displaySex(null)).toBe("Not recorded");
    expect(displaySex("")).toBe("Not recorded");
    // The old mapping collapsed anything non-male to Female. Never again:
    expect(displaySex("nonbinary")).toBe("Other");
    expect(displaySex("x")).toBe("Other");
  });
});
