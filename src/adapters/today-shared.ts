/**
 * Server-safe Today helpers (no "use client"): the dynamic /today page
 * computes the weekday at request time and passes it down, so prerender,
 * SSR, and hydration always agree on what "today" is.
 */

/**
 * Effective demo weekday: the calendar template covers Mon–Fri; on a
 * weekend the brief shows Monday's template with an explicit note.
 */
export function effectiveWeekday(now = new Date()): {
  weekday: number;
  isWeekendFallback: boolean;
} {
  const js = now.getDay(); // 0 Sun … 6 Sat
  if (js === 0 || js === 6) return { weekday: 1, isWeekendFallback: true };
  return { weekday: js, isWeekendFallback: false };
}
