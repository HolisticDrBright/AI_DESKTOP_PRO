export interface CalendarSlotBounds {
  dayStart: number;
  dayEnd: number;
  pxPerMin: number;
  stepMin?: number;
}

/** Convert a pointer offset in the calendar column to a safe, snapped start time. */
export function calendarSlotFromOffset(
  offsetY: number,
  { dayStart, dayEnd, pxPerMin, stepMin = 15 }: CalendarSlotBounds,
): number {
  if (!Number.isFinite(offsetY) || !Number.isFinite(pxPerMin) || pxPerMin <= 0) {
    return Math.min(Math.max(9 * 60, dayStart), Math.max(dayStart, dayEnd - stepMin));
  }

  const rawMinutes = dayStart + offsetY / pxPerMin;
  const snapped = Math.round(rawMinutes / stepMin) * stepMin;
  return Math.min(Math.max(snapped, dayStart), Math.max(dayStart, dayEnd - stepMin));
}
