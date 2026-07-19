import type { NextConfig } from "next";

/**
 * Recording/transcript no-tracker boundary (Milestone 1, req 9) — enforced
 * TECHNICALLY, not by convention:
 *
 *  - A strict Content-Security-Policy on the encounter (recording) routes:
 *    connect-src 'self' only, so the browser refuses any third-party request
 *    (analytics, session replay, error-payload capture, telemetry) from pages
 *    where audio capture and transcripts live. Scripts/styles/fonts/media are
 *    same-origin only; no external destinations exist to leak to.
 *  - The e2e suite additionally fails if ANY non-allowlisted network request
 *    is observed on these routes (e2e/live-scribe.spec.ts).
 */
const RECORDING_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'", // Next.js inline runtime; no external scripts
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "media-src 'self' blob:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "frame-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "base-uri 'self'",
].join("; ");

const nextConfig: NextConfig = {
  reactStrictMode: true,
  async redirects() {
    // Route consolidation (practitioner-OS IA). Old URLs stay alive —
    // see docs/information-architecture.md. Mode-dependent redirects
    // (/, /wearables, /quantum-mind, /nutrition) live in their pages.
    return [
      { source: "/practice", destination: "/today", permanent: false },
      { source: "/clients", destination: "/patients", permanent: false },
      { source: "/messages", destination: "/inbox", permanent: false },
      { source: "/automations", destination: "/integrations?tab=automations", permanent: false },
      { source: "/imports", destination: "/settings/data?tab=imports", permanent: false },
      { source: "/ai-safety", destination: "/settings/governance?tab=ai", permanent: false },
      { source: "/audit-log", destination: "/settings/governance?tab=audit", permanent: false },
      { source: "/claims", destination: "/billing?tab=claims", permanent: false },
      { source: "/assessments", destination: "/templates?type=assessment", permanent: false },
    ];
  },
  async headers() {
    return [
      {
        // Encounter workspace = recording + transcript surface.
        source: "/patients/:patientId/encounter/:encounterId*",
        headers: [
          { key: "Content-Security-Policy", value: RECORDING_CSP },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Permissions-Policy", value: "microphone=(self), camera=(), geolocation=()" },
        ],
      },
      {
        // The live scribe API routes carry tokens + audio: never cached,
        // never referred.
        source: "/api/live/scribe/:path*",
        headers: [
          { key: "Cache-Control", value: "no-store, no-cache, must-revalidate" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Content-Type-Options", value: "nosniff" },
        ],
      },
    ];
  },
};

export default nextConfig;
