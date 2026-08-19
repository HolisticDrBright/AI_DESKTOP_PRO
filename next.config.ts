import type { NextConfig } from "next";
import { resolveEdition, type AppEdition } from "./src/lib/edition.build";

/**
 * EDITION RESOLUTION AT BUILD TIME — THIS REPOSITORY IS THE CLINICAL PRODUCT.
 *
 * The demo edition now lives exclusively in `AI-DESKTOP-PRO-DEMO`; it is no
 * longer a supported production runtime here. Two rules are enforced as
 * compile-time constants, deliberately NOT read from the environment:
 *
 *   1. `EDITION_LOCK = "clinical"` — `APP_EDITION=demo` fails the build. A
 *      demo binary must not be produced from the repository that also holds
 *      the clinical deployment configuration.
 *   2. `requireExplicit` — a MISSING `APP_EDITION` also fails the build. Real
 *      patient software is built by someone who said `APP_EDITION=clinical`,
 *      never by a default a deploy pipeline forgot to override.
 *
 * Unit tests still construct both editions to prove the fixture barrier from
 * both sides — they stub `NEXT_PUBLIC_*` and never execute this file. That is
 * the intended split: every production build path runs through here and hits
 * the lock; the test runner exercises the runtime module directly.
 *
 * Next.js only inlines `NEXT_PUBLIC_*` into the browser bundle, so the
 * validated value is published as `NEXT_PUBLIC_APP_EDITION`; that is what
 * `src/lib/edition.ts` reads.
 */
const EDITION_LOCK: AppEdition = "clinical";

const EDITION: AppEdition = resolveEdition(process.env.APP_EDITION, EDITION_LOCK, {
  requireExplicit: true,
});

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
// Next's development runtime evaluates its generated source maps in the
// browser. Without this development-only allowance, encounter pages render
// their server shell but never hydrate under `next dev` (including the local
// contract-fixture browser suite). Production builds retain the strict
// no-eval policy below.
const DEVELOPMENT_SCRIPT_EVAL = process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : "";

const RECORDING_CSP = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${DEVELOPMENT_SCRIPT_EVAL}`, // no external scripts
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
  // Produce the traced, minimal Node runtime used by the AWS-hosted clinical
  // container. Build-time edition checks remain authoritative.
  output: "standalone",
  /**
   * Publish the validated edition to the browser bundle. `src/lib/edition.ts`
   * reads these two and nothing else.
   */
  env: {
    NEXT_PUBLIC_APP_EDITION: EDITION,
    NEXT_PUBLIC_EDITION_LOCK: EDITION_LOCK,
  },
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
    // EDITION is always "clinical" here (the lock above guarantees it); the
    // demo's whole-app egress CSP now lives only in AI-DESKTOP-PRO-DEMO.
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
