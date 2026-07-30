/** Money is integer cents ("minor units") everywhere in the mock ledger. */

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

/** Synthetic "Stripe test mode" card fee: 2.9% + 30¢, rounded. Demo math only. */
export function testModeFeeMinor(amountMinor: number): number {
  if (amountMinor <= 0) return 0;
  return Math.round(amountMinor * 0.029) + 30;
}
