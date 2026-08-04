# Phase 9E-B — Curation pilot (bounded)

**Base:** post-merge `main` at Phase 9E-A.2 merge SHA `996e996`.

**Branch:** `claude/clinical-runtime-phase9e-b-curation-pilot`.

## Objective

Phase 9E-B is a bounded practitioner-curation pilot against the eight real
preview batches already staged in staging project `urcjiehlxoehievobezf`.

It is **not** another schema-building phase. Migrations only if the real
workflow surfaces a genuine defect.

The pilot goes as far as a governed automated pipeline can safely go, then
**stops at the practitioner decision checkpoint** — every clinical judgment
that requires the operator is queued, never made by this session.

## Scope constraints

- Only Supabase project `urcjiehlxoehievobezf`.
- No AI Longevity Pro, no demo repository, no rork, no mobile repositories,
  no production infrastructure, no other Supabase project.
- No service-role / MCP-administrative writes that would impersonate a
  practitioner decision. The signed-in practitioner session is the only
  legal path for later authorized decisions.
- Real preview aggregates preserved unless a test-only transaction is
  rolled back.

Baseline, sanitized inventory, pilot actions, actions deliberately not
performed, and practitioner decisions still required — recorded below.
