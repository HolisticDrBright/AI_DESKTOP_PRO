/**
 * Money is integer cents ("minor units") everywhere: database columns
 * (`*_minor`), wire DTOs (`*Minor`), and these helpers. Nothing rounds
 * through a float, so a displayed total is exactly the recorded one.
 */

export function formatMinor(minor: number): string {
  const sign = minor < 0 ? "-" : "";
  const abs = Math.abs(Math.round(minor));
  const dollars = Math.floor(abs / 100);
  const cents = String(abs % 100).padStart(2, "0");
  return `${sign}$${dollars.toLocaleString("en-US")}.${cents}`;
}

/** "12.34" | "$12.34" | "12" → cents; NaN-safe (returns null on junk). */
export function parseToMinor(input: string): number | null {
  const cleaned = input.replace(/[$,\s]/g, "");
  if (!/^\d*\.?\d{0,2}$/.test(cleaned) || cleaned === "" || cleaned === ".") return null;
  return Math.round(parseFloat(cleaned) * 100);
}

/**
 * Illustrative card fee (2.9% + 30¢). NOT a processor figure and never
 * recorded: no fee is stored on any payment, so this must not be presented
 * as an amount the practice was actually charged.
 */
export function testModeFeeMinor(amountMinor: number): number {
  if (amountMinor <= 0) return 0;
  return Math.round(amountMinor * 0.029) + 30;
}
