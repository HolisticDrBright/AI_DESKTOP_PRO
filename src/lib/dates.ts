/**
 * Date-only handling for clinical demographics (P0).
 *
 * A `yyyy-mm-dd` value is a CALENDAR date with no timezone. Parsing it with
 * `new Date("1990-04-12")` interprets it as UTC midnight, which renders as the
 * PREVIOUS day in any timezone west of UTC (e.g. Pacific) — wrong DOBs and
 * off-by-one ages. These helpers never construct a Date from a date-only
 * string; they work on calendar components directly.
 */

export interface CalendarDate {
  y: number;
  m: number; // 1-12
  d: number; // 1-31
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})/;

/** Parse a date-only (or ISO datetime) string into calendar components. */
export function parseDateOnly(value: string | null | undefined): CalendarDate | null {
  if (!value) return null;
  const m = DATE_ONLY.exec(value);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 1850 || y > 2200) return null;
  return { y, m: mo, d };
}

/** Today as LOCAL calendar components (injectable for tests). */
export function localToday(now: Date = new Date()): CalendarDate {
  return { y: now.getFullYear(), m: now.getMonth() + 1, d: now.getDate() };
}

/**
 * Whole-year calendar age, or null when the birth date is unknown/unparseable —
 * an unknown age is reported as unknown, never fabricated as 0.
 */
export function calendarAge(
  dob: string | null | undefined,
  today: CalendarDate = localToday(),
): number | null {
  const b = parseDateOnly(dob);
  if (!b) return null;
  let age = today.y - b.y;
  if (today.m < b.m || (today.m === b.m && today.d < b.d)) age -= 1;
  return age >= 0 && age <= 150 ? age : null;
}

/** mm/dd/yyyy for display, or "—" when not recorded. */
export function formatDateOnly(value: string | null | undefined): string {
  const p = parseDateOnly(value);
  if (!p) return "—";
  return `${String(p.m).padStart(2, "0")}/${String(p.d).padStart(2, "0")}/${p.y}`;
}

export type SexDisplay = "Female" | "Male" | "Other" | "Unknown" | "Not recorded";

/**
 * Recorded sex → display, WITHOUT guessing: anything unrecognized is shown as
 * what it is (Other/Unknown), and a missing value is "Not recorded".
 */
export function displaySex(raw: string | null | undefined): SexDisplay {
  switch ((raw ?? "").trim().toLowerCase()) {
    case "female":
    case "f":
      return "Female";
    case "male":
    case "m":
      return "Male";
    case "other":
    case "intersex":
    case "nonbinary":
    case "non-binary":
      return "Other";
    case "unknown":
      return "Unknown";
    case "":
      return "Not recorded";
    default:
      return "Other";
  }
}
