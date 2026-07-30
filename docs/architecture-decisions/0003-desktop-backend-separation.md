# ADR 0003 — AI Desktop Pro owns its backend boundary

- **Status:** Accepted (2026-07-28)
- **Owners:** HolisticDrBright (product), platform engineering
- **Supersedes:** the shared-backend portions of ADR 0001 and ADR 0002
- **Applies to:** `AI_DESKTOP_PRO`

## Context

AI Desktop Pro and AI Longevity Pro are separate products and repositories.
Desktop work must not add branches, procedures, migrations, or deployment
requirements to the AI Longevity Pro repository
(`rork-ai-longevity-coach`). The mobile product may consume a stable Desktop
API later, but it does not host Desktop's clinical backend.

## Decision

AI Desktop Pro owns its clinical data boundary.

```
browser → same-origin Next.js route → clinical Supabase REST/RPC
                                     under the practitioner's JWT + RLS
```

- The browser never receives database credentials or calls PostgREST directly.
- Server routes use the publishable key plus the signed-in practitioner's
  bearer token. RLS and role-gated RPCs remain authoritative.
- Desktop clinical paths never use a Supabase service-role key.
- New Desktop backend code lives in `AI_DESKTOP_PRO` or in a future dedicated
  Desktop-owned API repository.
- No Desktop feature branch or PR is created in `rork-ai-longevity-coach`.
- Existing tRPC-backed Desktop routes are transitional. Each domain moves to
  the Desktop-owned boundary in a tested vertical slice.

## Consequences

- The clinical knowledge registry was the first independent live slice.
- Identity/session lifecycle, organization selection and membership
  management, and the patient directory/profile read path now use the same
  Desktop-owned boundary.
- AI Longevity Pro remains clean and can evolve independently.
- Shared concepts are exchanged later through versioned API contracts, not
  copied backend code.
- A future AWS migration can replace the server-side transport without
  changing browser components or weakening the RLS/RPC contracts.
