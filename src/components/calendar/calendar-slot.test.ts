import { describe, expect, it } from "vitest";
import { calendarSlotFromOffset } from "./calendar-slot";

const bounds = { dayStart: 8 * 60, dayEnd: 18 * 60, pxPerMin: 0.9 };

describe("calendarSlotFromOffset", () => {
  it("snaps a clicked position to the nearest 15-minute start", () => {
    expect(calendarSlotFromOffset(99, bounds)).toBe(9 * 60 + 45);
  });

  it("clamps clicks before and after the visible day", () => {
    expect(calendarSlotFromOffset(-100, bounds)).toBe(8 * 60);
    expect(calendarSlotFromOffset(10_000, bounds)).toBe(17 * 60 + 45);
  });

  it("uses a safe 9 AM fallback for keyboard activation", () => {
    expect(calendarSlotFromOffset(Number.NaN, bounds)).toBe(9 * 60);
  });
});
