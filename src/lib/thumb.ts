/**
 * Deterministic LOCAL thumbnail generator (program covers, food photos,
 * attachment previews). Emits a self-contained SVG data URI — no remote
 * hotlinks, no network fetch, stable per seed so demo screens don't shuffle.
 */

const PALETTES: [string, string][] = [
  ["#0D5C63", "#1A7A82"],
  ["#1B4FA5", "#2563C7"],
  ["#5D4BB5", "#7461C9"],
  ["#B45309", "#C77E14"],
  ["#1F9D63", "#22B573"],
  ["#3D5A80", "#5C7FA8"],
  ["#8C3B8F", "#B15CB4"],
  ["#A63D3D", "#D6544A"],
];

function hash(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** SVG data URI, 16:10, gradient + deterministic geometric motif. */
export function thumbDataUri(seed: string, label = ""): string {
  const h = hash(seed);
  const [a, b] = PALETTES[h % PALETTES.length];
  const motif = h % 3;
  const cx = 40 + (h % 240);
  const cy = 30 + ((h >> 4) % 140);
  const shapes =
    motif === 0
      ? `<circle cx="${cx}" cy="${cy}" r="86" fill="rgba(255,255,255,0.14)"/><circle cx="${320 - cx}" cy="${200 - cy}" r="52" fill="rgba(255,255,255,0.10)"/>`
      : motif === 1
        ? `<rect x="${cx - 60}" y="${cy - 60}" width="150" height="150" rx="28" fill="rgba(255,255,255,0.12)" transform="rotate(18 ${cx} ${cy})"/><rect x="${300 - cx}" y="${170 - cy}" width="90" height="90" rx="20" fill="rgba(255,255,255,0.10)" transform="rotate(-12 ${300 - cx} ${170 - cy})"/>`
        : `<path d="M0 ${140 + (h % 40)} Q 90 ${90 + (h % 60)} 180 ${130 + (h % 30)} T 320 ${110 + (h % 50)} V 200 H 0 Z" fill="rgba(255,255,255,0.13)"/>`;
  const text = label
    ? `<text x="18" y="182" font-family="Inter, sans-serif" font-size="17" font-weight="700" fill="rgba(255,255,255,0.92)">${label
        .slice(0, 26)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")}</text>`
    : "";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200" viewBox="0 0 320 200"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="320" height="200" fill="url(#g)"/>${shapes}${text}</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}
