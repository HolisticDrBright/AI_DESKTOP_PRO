# Clinical runtime migration

The living inventory of every surface in the clinical product: what is real,
what refuses honestly, and what each domain needs to go live. Updated with
every phase. Phase 1 made the runtime clinical-only and shipped the first real
vertical slice. Phase 2 made front-desk scheduling a database-enforced state
machine and shipped versioned protocol + template persistence with a real
product-catalog picker and a deterministic-or-honest interaction review.
Phase 3 made Programs & Education real: org-owned programs with versioned
curricula (modules → lessons → typed blocks), a review → approve → publish
lifecycle with immutable published versions, offers that store commercial
terms only, and enrollments pinned to exact published versions with
append-only progress. Phase 4 made the inbox real: org-scoped conversation
threads with a database-enforced workflow, immutable messages with versioned
drafts, a durable outbox whose sending FAILS CLOSED without a delivery
provider, communication preferences and consent gates, a deterministic
urgent-language invariant, and AI triage that is stored separately and acts
only on explicit human acceptance. Phase 5 built the Desktop side of the AI
Longevity Pro patient delivery & synchronization gateway: explicit patient-app
connections (opaque single-use invitations, verified subject binding),
independent versioned consent scopes, versioned sync envelopes with a durable
at-least-once engine (idempotency, dedup, bounded retry, dead letters,
explicit conflicts), and a provider boundary that FAILS CLOSED — no delivery
or acknowledgment claim exists without provider evidence. Phase 8A made the
money real: an org-scoped catalog with suppliers, locations, and tax rates;
per-location inventory whose every movement is an append-only ledger row;
appointment checkout into immutable finalized invoices with snapshotted lines
and SERVER-PRICED tax; manual payments, patient credit, and refunds that never
restock; test-mode card payments that a browser can only ever start,
settled solely by a server-side webhook with durable dedup; and an inventory
accounting policy — reserve at finalize, commit the sale exactly once at
settlement, release on void — that makes overselling a typed conflict rather
than a negative number.

**The core rule.** A domain loses its mock runtime implementation only when it
has (1) a real authenticated implementation, or (2) an honest unavailable /
not-configured state. The clinical application never fabricates patient
information to make a screen look complete. Structural enforcement:

- `npm run check:mock-imports` — walks the real import graph from every
  `src/app` entry file; fails if any path reaches `*.mock.ts` or a demo
  session store. Type-only imports are erased and allowed.
- `npm run check:clinical-bundle` — strict scan of the built client chunks for
  fixture identities and demo copy. Zero tolerance since phase 1.
- `src/adapters/clinical-fixture-barrier.test.ts` — every unwired registry
  namespace refuses with `unavailable`; refusals leak no fixture identity;
  live namespaces fail on transport rather than degrade to fixtures.

Synthetic data may exist ONLY in: `src/adapters/*.mock.ts` (unit-test
fixtures), `scripts/live-stub-server.mjs` (contract-fixture e2e), and
`supabase/seed/*` (clearly-labelled staging seeds).

## Status classification

| Class | Meaning |
| --- | --- |
| **Real & verified** | Live reads/writes through the Desktop-owned boundary, covered by SQL acceptance + e2e |
| **Real, worker-bound (transitional)** | Live, but the operation legitimately runs on the worker/provider boundary |
| **Schema ready** | Tables + RLS exist; app-facing functions/UI not built |
| **Needs schema** | No adequate tables yet |
| **External integration required** | Blocked on a third-party (payments, lab vendor, wearables, comms) |
| **Not configured** | Honest unavailable state in the UI; nav preserved |

## Domain inventory

### Real & verified (Desktop-owned, practitioner JWT + RLS + membership + patient access)

| Domain | Route(s) | Adapter | Table/RPC | Audit | Acceptance |
| --- | --- | --- | --- | --- | --- |
| Authentication (sign-in, session cookie, org selection) | `/login`, `/reset` | `auth.server.ts` | Supabase Auth + validated `aidp_org` cookie | access_events | auth.server.test, live e2e |
| Organizations & memberships | `/settings` | `organizations.live.ts` | `organization_memberships`, mgmt RPCs | audit_events | org_membership.sql |
| Patient directory / profile reads | `/patients`, chart header | `patients.live.ts` | `patient_profiles` (RLS) | access layer | desktop_identity_directory.sql |
| **Patient overview (Phase 1)** | `/patients/[id]/overview` | `overview.live.ts` → `PatientOverviewLive` | `get_patient_overview` | read-only | desktop_patient_overview.sql (18) |
| **Clinical reasoning + review (Phase 1)** | labs tab → Clinical reasoning | `reasoning.live.ts` → `ReasoningWorkspace` | `get_reasoning_workspace`, `review_hypothesis`, `hypothesis_reviews` | atomic audit_events per review | desktop_reasoning_review.sql (22) |
| Labs workspace + biomarker review | `/patients/[id]/labs` | `labs.live.ts` | `list_patient_lab_observations`, `review_biomarker` | atomic | desktop_labs_review_queue.sql |
| Review queue (read + resolve) | `/tasks` | `tasks.live.ts` | `list_review_queue`, `resolve_review_queue_item` | atomic | resolve_review_queue_item.sql |
| Audit log viewer | Settings → Governance | `actions.live.ts` | `list_audit_events` | is the audit | desktop_audit_actions.sql |
| Scheduling (read week, book, reschedule) | `/calendar` | `schedule.live.ts` | `get_desktop_calendar` (+`version`), `book_appointment`, `reschedule_appointment` | atomic | desktop_scheduling.sql |
| **Front-desk status machine (Phase 2)** | `/calendar` drawer, `/today` | `frontdesk.live.ts` → `CalendarView` drawer, `TodayScheduleLive` | `transition_appointment`, `correct_appointment_status`, `appointment_status_events`, `private.appointment_transition_allowed`; `start_encounter` extended to transition the linked appointment | atomic; corrections separately audited with reason | desktop_frontdesk_transitions.sql (29) |
| **Protocols + templates (Phase 2)** | `/patients/[id]/protocol` | `protocols.live.ts` → `ProtocolWorkspace` | `protocols`, `protocol_templates`, `protocol_versions`, `protocol_phases`, `protocol_items`; `get_patient_protocol`, `create_protocol_draft`, `save_protocol_draft`, `approve_protocol_version`, `activate_protocol_version`, `set_protocol_lifecycle`, `revise_protocol_version`, `list/create/approve/archive` template RPCs | atomic; approval/activation/lifecycle each audited | desktop_owned_protocols.sql (36) |
| **Protocol catalog + interaction review (Phase 2)** | protocol tab product picker | `protocols.live.ts` | `search_protocol_catalog`, `check_protocol_interactions`, `review_protocol_item_interactions`, `private.catalog_verification_status` over the 0007 supplement catalog | review action audited | desktop_protocol_catalog_interactions.sql (37) |
| **Programs & Education (Phase 3)** | `/programs`, `/programs/[id]`, chart overview card, `/today` summary | `programs.live.ts` → `ProgramsWorkspace`, `ProgramStudio`, `PatientProgramsLive`, `TodayProgramsLive` | `programs`, `program_templates`, `program_versions`, `program_modules`, `program_lessons`, `program_blocks`, `program_offers`, `program_enrollments`, `program_progress`, `program_version_events`, `program_enrollment_events`; 20 RPCs (`list_programs`, `get_program_studio`, `list_program_templates`, `get_patient_programs`, `create_program`, `save_program_draft`, `submit/return/approve/publish/revise_program_version`, `archive_program`, `create/approve/archive` template RPCs, `upsert_program_offer`, `enroll_patient_in_program`, `set_program_enrollment_status`, `record_program_progress`, `review_program_progress`) | atomic; creation/lifecycle/offer/enrollment/progress each audited, PHI-safe (payloads never in audit rows) | desktop_owned_programs_phase3.sql (71) |
| **Inbox, messaging & AI triage (Phase 4)** | `/inbox` (3-pane workspace), chart Messages tab, `/today` inbox card | `inbox.live.ts` → `InboxWorkspace`, `PatientMessagesLive`, `TodayInboxLive`; `messaging-provider.ts` (contract only) | `conversations` (extended), `messages` (extended), `message_draft_revisions`, `message_attachments`, `communication_preferences`, `message_outbox`, `message_delivery_events`, `conversation_events`, `message_ai_reviews`; 16 caller RPCs (`list_inbox`, `get_conversation`, `create_conversation`, `save_message_draft`, `cancel_message_draft`, `send_message`, `mark_conversation_read`, `update_conversation_workflow`, `create_task_from_message`, `append_message_to_note`, `set_communication_preferences`, `register_message_attachment`, `review_ai_suggestion`, `get_patient_messages`, `get_inbox_today_summary`) + 3 service_role-only worker RPCs (`record_inbound_message`, `record_delivery_callback`, `record_ai_suggestion`) | atomic; thread lifecycle, send refusals, AI decisions each audited; PHI-safe (message bodies never in audit rows or logs) | desktop_owned_inbox.sql (61) |
| **Patient delivery & sync gateway (Phase 5)** | chart "Patient App" tab (`/patients/[id]/app-sync`), `/integrations` | `patient-sync.live.ts` -> `PatientSyncPanel`, `SyncOperationsPanel`; `patient-sync-provider.ts` (contract only) | `patient_app_connections`, `patient_sync_invitations`, `sync_consent_scopes`, `sync_outbound_events`, `sync_inbound_events`, `sync_inbound_corrections`, `sync_delivery_attempts`, `sync_delivery_events`, `sync_dead_letters`, `sync_cursors`, `sync_conflicts`, `sync_resource_acks`, `sync_connection_events`; 13 caller RPCs + 4 service_role worker RPCs (`verify_sync_invitation`, `claim_sync_outbound`, `record_sync_delivery`, `record_sync_inbound`) | atomic; every lifecycle/consent/queue/retry/review action audited PHI-safe; security-relevant history in `sync_connection_events` | desktop_patient_sync.sql (80) |
| **Billing, checkout, catalog & inventory (Phase 8A)** | `/billing`, `/billing/[invoiceId]`, `/settings/catalog`, chart Billing tab, calendar checkout | `billing.live.ts` → `BillingWorkspace`, `InvoiceDetail`, `CatalogWorkspace`, `PatientBillingLive`, `CheckoutButton` | `suppliers`, `locations`, `tax_rates`, `product_commercial_links`, `inventory_stock`, `inventory_ledger`, `invoice_events`, `payment_events`, `patient_credit_entries`, `billing_webhook_events` + extended `products_services`, `invoices`, `invoice_line_items`, `payments`, `refunds`; 22 caller RPCs (`upsert_billing_location/supplier/tax_rate/product`, `archive_billing_product`, `list_billing_catalog`, `receive/adjust/return_inventory_stock`, `get_inventory_history`, `create_invoice_draft`, `save_invoice_draft`, `finalize_invoice`, `void_invoice`, `record_manual_payment`, `grant/apply_patient_credit`, `refund_payment`, `start_card_payment`, `get_billing_invoice`, `get_patient_billing`, `get_billing_workspace`) + 2 service_role-only processor RPCs (`attach_payment_processor_ref`, `record_billing_webhook`) | atomic; product, stock, invoice, payment, credit, and refund actions each audited PHI-safe; append-only `invoice_events` / `payment_events` / `inventory_ledger` | desktop_owned_billing.sql (96) |
| **Plans, memberships, entitlements & reconciliation (Phase 8B)** | `/settings/plans`, `/billing/reconciliation`, `/billing/reports`, chart `Plans & Credits` tab, `POST /api/live/stripe/webhook` | `plans.live.ts` → `PlansWorkspace`, `PatientPlansLive`, `ReconciliationWorkspace`, `FinancialReports`; `stripe-boundary.ts` (real, disabled by default) + `stripe-processor.server.ts` (service_role only) | `package_versions`, `membership_versions`, `plan_acceptances`, `patient_memberships`, `patient_membership_events`, `entitlements`, `entitlement_ledger`, `org_billing_policies`, `processor_customers`, `reconciliation_exceptions`, `reconciliation_events`, `financial_permission_grants` + extended `packages`, `memberships`, `package_redemptions`, `billing_webhook_events`; 17 caller RPCs, each behind a SPECIFIC financial permission | atomic; plan, entitlement, membership, complimentary, and reconciliation actions each audited PHI-safe; append-only `entitlement_ledger` / `patient_membership_events` / `reconciliation_events` | desktop_plans_entitlements.sql (26) |
| Encounters, notes, signatures, addenda, timeline | `/patients/[id]/chart`, encounter workspace | `encounters.live.ts` | `start_encounter`, `get_desktop_note`, `get_desktop_patient_timeline`, … | atomic; signed-note immutability | desktop_encounters_notes.sql |
| Lens lifecycle + reference reads | encounter workspace | `lens.live.ts` | desktop lens RPCs | atomic | desktop_lens acceptance |
| Clinical knowledge registry + imports | Settings → Knowledge | `knowledge.live.ts` | registry RPCs | atomic | clinical_knowledge_*.sql |

### Real, worker-bound (transitional by design — do NOT move into browser routes)

| Operation | Why worker-bound | Provider failure behavior |
| --- | --- | --- |
| Lens evaluation / AI status | rules + AI engine on the worker | explicit error; deterministic layer independent |
| Scribe binary audio upload | streams + storage coordination | explicit failure; consent gates unchanged |
| ASR transcription | provider integration | job status honest; no fake transcript |
| Scribe AI draft generation | provider integration | not-configured message; no fixture draft |
| Lab PDF extraction/storage | storage + extraction jobs | "failed" is honest: PDF stored for manual review, failure audited |

### Not configured (honest unavailable states; navigation preserved)

The Today page now shows THREE real aggregations: today's appointments with
their real statuses, the Programs summary, and the Inbox summary (open
threads, unread inbound, urgent flags, due follow-ups, my assignments — all
counts of persisted rows). Notes awaiting signature, wearable alerts, and
balances are named as not configured on that page — no count is shown for a
domain with no live backend.

Within the now-real inbox, two boundaries stay honestly unavailable by
design: **message delivery** (no provider is configured — `send_message`
refuses durably and nothing is marked sent/delivered without a provider
acknowledgment recorded via `record_delivery_callback`) and the **AI inbox
copilot** (`api.inbox.copilotAI` fails closed as not configured; suggestions
can only enter through the service_role `record_ai_suggestion` boundary and
only act when a human accepts them).

| Domain | Route | First real mutation when built | Needs |
| --- | --- | --- | --- |
| Message delivery (ALP in-app/email/SMS/push) | `/inbox` composer | provider-acknowledged send | `MessagingProvider` implementation + `messaging` connector registration + outbox worker |
| AI inbox copilot | `/inbox` AI panel | recorded suggestion | governed AI config + worker calling `record_ai_suggestion` |
| A Stripe test-mode transaction | `/billing` checkout, `/settings/plans` | a processor-confirmed charge | Phase 8B ships the REAL signature-verifying adapter, disabled by default. No test credentials exist in this environment, so **no Stripe API call has ever run** (`liveTransactionExecuted` is false and every surface says so). Supplying `STRIPE_TEST_MODE_ENABLED` + the two test keys activates it with no code change |
| Live (production) Stripe | — | a real charge | Refused by design: live keys and live-mode objects are rejected outright. Needs an account, PCI review, and a separate deliberate decision |
| Insurance claims | `/billing?tab=claims` | submit claim | clearinghouse integration (deliberately out of phase 8A) |
| Nutrition persistence | chart Nutrition tab | save diet plan | schema ready |
| Health Twin | chart Tracking tab | approve snapshot | schema ready (`outcome_snapshots`) |
| N-of-1 experiments | chart Tracking tab | start experiment | schema ready (`experiments`) |
| Wearables | chart Tracking tab | connect source | external integration |
| Record imports | Settings → Data | approve import batch | parse+match pipeline |
| AI Longevity Pro sync provider | chart Patient App tab, `/integrations` | provider-acknowledged delivery | `PatientSyncProvider` implementation + `alp_patient_sync` connector registration + sync worker |
| AI sync summary | Patient App tab AI panel | reviewable draft summary | governed AI config; human review already live |
| Invitation delivery | Patient App tab | transmitted invitation | delivery provider (the one-time code is conveyed manually today) |
| Other external integrations (EHR, lab vendors, wearables, automations, webhooks) | `/integrations` | connect connector | per-connector |
| Telehealth | calendar drawer | join visit | external integration |
| Reports | `/reports` | save report run | access-scoped aggregate queries |
| Templates | `/templates` | publish template version | schema ready (`templates`) |
| Team role matrix | `/team` | change role (exists via org mgmt) | read UI over memberships |
| Assistant | drawer | grounded answer w/ provenance | governed AI config |
| Composer draft generation | composer | generated draft | governed AI config |
| Health score | overview | n/a | governed algorithm (inputs, version, review status) — **must not be calculated before then** |
| Command-palette patient search | ⌘K | n/a | live directory search endpoint |
| Notifications | top bar | n/a | live feed |
| Practice optimal ranges | labs config | save range | schema (practice_ranges) |
| Lab ordering | labs Orders tab | create requisition | external integration (lab vendor) |

## Migration ledger (project `urcjiehlxoehievobezf`)

Phase 1 found the ledger ending at `20260730002121 worker_callback_ledger_privileges`
(exactly as expected) and appended:

| Version | Name | What |
| --- | --- | --- |
| `20260730033436` | desktop_owned_patient_overview | `get_patient_overview` bounded aggregate |
| `20260730033559` | desktop_owned_reasoning_review | `hypothesis_reviews` + workspace read + atomic review RPC |
| `20260730034530` | desktop_hypothesis_review_indexes | FK covering indexes (closes the 3 introduced advisor INFOs) |

Phase 2 found the ledger ending at `20260730034530` and appended:

| Version | Name | What |
| --- | --- | --- |
| `20260730042846` | desktop_frontdesk_transitions | `in_encounter` status, `appointments.version`, `appointment_status_events`, transition/correction RPCs, `start_encounter` extension |
| `20260730042928` | desktop_frontdesk_calendar_version | `get_desktop_calendar` byte-identical + `version` in the appointment projection |
| `20260730043030` | desktop_owned_protocols | protocol/template/version/phase/item tables, RLS, immutability triggers, FK covering indexes |
| `20260730043300` | desktop_protocol_rpcs | the 11 protocol + template RPCs |
| `20260730045821` | desktop_protocol_catalog_interactions | catalog picker, derived verification, deterministic interaction check, practitioner review RPC |
| `20260730050009` | desktop_protocol_draft_verification | `save_protocol_draft` replaced: verification derived server-side, catalog identity from the catalog, version-must-belong-to-product |
| `20260730052613` | desktop_protocol_draft_item_ids | `save_protocol_draft` returns `itemIds` (payload order) so reviews can target persisted rows |

Phase 3 found the ledger ending at `20260730052613` and appended:

| Version | Name | What |
| --- | --- | --- |
| `20260730155911` | desktop_owned_programs | extends the 0009 program skeleton: versioned program/template curricula, offers, pinned enrollments, append-only progress + events, frozen-content triggers, single-policy RLS with all direct writes revoked, unique `(program_id, version)` / `(template_id, version)` |
| `20260730161830` | desktop_program_rpcs | 4 private helpers + the 20 program RPCs |
| `20260730171151` | desktop_program_fk_indexes | covering indexes for every remaining unindexed FK on the Desktop-owned program tables |

Phase 4 found the ledger ending at `20260730171151` and appended:

| Version | Name | What |
| --- | --- | --- |
| `20260730182450` | desktop_owned_inbox | extends `conversations` (10 categories, priority, assignment, queues, follow-up/snooze, urgent invariant fields, `version`; status `open/snoozed/resolved`, legacy `closed`→`resolved`) and `messages` (8-state machine, channel, `version`, delivery timestamps, PHI-safe failure reason, provenance); new tables `message_draft_revisions`, `message_attachments` (opaque `storage_ref`, provider `none`/`supabase_storage`, no URLs), `communication_preferences`, `message_outbox` (unique idempotency key, unique `(message_id, channel)`), `message_delivery_events` (unique `(provider, provider_event_id)` — callback dedup), `conversation_events` (append-only), `message_ai_reviews` (immutable content, versioned prompt/model/schema/provider + output hash); `private.detect_urgent_language` (IMMUTABLE, fixed dictionary); immutability triggers (sent/inbound bodies frozen, DELETE blocked, events and AI content unmutable); legacy policies dropped, patient-access-scoped SELECT RLS, ALL direct writes revoked, every FK indexed |
| `20260730183610` | desktop_inbox_rpcs | 5 private helpers (`can_handle_inbox`, `messaging_provider_configured`, `inbox_thread_guard`, `log_conversation_event`, `apply_urgent_invariant`) + 14 caller RPCs + `review_ai_suggestion` + 3 service_role-only worker-boundary RPCs |
| `20260730183800` | desktop_inbox_task_type_fix | `create_task_from_message` writes lawful `review_queue_items` values (`patient_message`/`open`) |
| `20260730184141` | desktop_inbox_draft_insert_fix | draft insert matches the real `messages` shape (authorship is `sender_user_id`) |
| `20260730184914` | desktop_inbox_note_provenance_message | `note_provenance_refs.ref_type` check widened to include `message` |
| `20260730185240` | desktop_inbox_send_refusal_outcome | `review_ai_suggestion` revoked from anon; `send_message` provider refusal became a durable RETURNED outcome (`{ok:false, sent:false, refusal:'provider_not_configured'}`, draft kept, `send_refused` event persists) instead of an exception that rolled its own trail back |

Phase 5 found the ledger ending at `20260730185240` and appended:

| Version | Name | What |
| --- | --- | --- |
| `20260730195014` | desktop_patient_sync_schema | `patient_app_connections` (explicit linking — NEVER matched by email/name/phone/DOB; one live connection per patient AND per external subject via partial unique indexes), `patient_sync_invitations` (sha256 hash only, expiring, single-use, deny-all RLS), `sync_consent_scopes` (11 independent versioned scopes; artifact/jurisdiction/method/authority; research separate), `sync_outbound_events` / `sync_inbound_events` (append-only envelopes: contract version, server event uid, idempotency key, payload hash, provenance, correlation/causation; immutability triggers freeze content and block DELETE), `sync_inbound_corrections` (versioned overlays), `sync_delivery_attempts` / `sync_delivery_events` (provider evidence, unique `(connection, provider_event_id)` callback dedup), `sync_dead_letters`, `sync_cursors`, `sync_conflicts`, `sync_resource_acks`, `sync_connection_events`; RLS selects scoped to membership + patient access; ALL direct writes revoked |
| `20260730201119` | desktop_patient_sync_rpcs | 13 caller RPCs (`get_patient_sync_overview`, `create_sync_invitation`, `pause/resume/revoke_sync_connection`, `set_sync_consent_scope`, `queue_sync_export` with SERVER-built minimum-necessary payloads, `withdraw_sync_resource`, `retry_sync_event` (reason required), `resolve_sync_conflict`, `review_sync_inbound`, `record_sync_inbound_correction`, `get_org_sync_operations`) + 4 service_role-only worker RPCs (`verify_sync_invitation`, `claim_sync_outbound`, `record_sync_delivery`, `record_sync_inbound`); `review_queue_items` gains lawful `sync_review` item type |

Phase 6A found the ledger ending at `20260730201119` and appended:

| Version | Name | What |
| --- | --- | --- |
| `20260730210813` | desktop_sync_worker_ops | lease columns (`lease_id`, `lease_expires_at`, `claimed_at`) + claimable/lease partial indexes on `sync_outbound_events`; `sync_worker_cycles` + `sync_circuit_states` (PHI-free, org-readable telemetry) and `sync_callback_nonces` (deny-all RLS); `private.sync_provider_posture` (disabled → fixture → approved precedence; `sync_contract_fixture` recognized as the TEST posture, `alp_patient_sync` as approved); `claim_sync_outbound` REPLACED as the single lease-aware overload (old `(uuid, integer)` signature dropped): expired-lease reclaim then `FOR UPDATE SKIP LOCKED` claim, returns lease id/expiry + `leaseReclaims` + `maxQueueAgeSeconds`; `recheck_sync_export` (consent/connection/supersession re-checked AT DELIVERY TIME; refusal is a durable cancel with an attempt row and a safe reason); `record_sync_worker_cycle` (validated circuit state, upserts the circuit row); `register_sync_callback_nonce` (unique-violation → `replay:true`, 7-day prune); `cancel_sync_event` (owner/admin/practitioner, reason required, queued/failed/dead_letter only, audited); `get_org_sync_operations` extended (posture, in-flight count, queue age, last worker cycle, circuit) |
| `20260730212353` | desktop_sync_requeue_generation | `queue_sync_export` idempotency block only: a live envelope still answers `alreadyQueued`, but an explicit re-share after a CANCELLED or SUPERSEDED envelope mints a NEW envelope generation (`:rN` key suffix) instead of being blocked forever — and a consent re-grant alone never resurrects cancelled work |

Phase 8B found the ledger ending at `20260731194520` and appended:

| Version | Name | What |
| --- | --- | --- |
| `desktop_plans_entitlements_schema` | EXTENDS the 0011 `packages` / `memberships` / `package_redemptions` skeleton in place (all verified empty) rather than creating a second plan, purchase, invoice, payment, webhook, or reconciliation model. `public.subscriptions` (0011) is deliberately untouched — it is the organization's own SaaS seat licence, a different domain from a patient membership. New: `financial_permission_grants` + `private.has_financial_permission` (11 granular permissions replacing phase 8A's single blanket gate), `package_versions` / `membership_versions` (immutable published terms), `plan_acceptances` (patient acceptance of an exact version), `patient_memberships` + append-only `patient_membership_events`, `entitlements` + append-only `entitlement_ledger`, `org_billing_policies` (explicit no-show / late-cancel rules), `processor_customers` (identifiers only), `reconciliation_exceptions` + append-only `reconciliation_events`. Guards: append-only triggers, `plan_version_protect` (published terms frozen), `entitlement_protect` (identity and grant size frozen). The entitlement quantity identity (`granted = remaining + reserved + consumed + expired + refunded`) plus partial unique indexes make double-granting a renewal and double-reserving one appointment impossible at the storage layer. `review_queue_items.item_type` widened with 8 dunning types |
| `desktop_plans_entitlements_rpcs` | 17 caller RPCs granted to `authenticated`, each enforcing `auth.uid()`, active membership, a SPECIFIC financial permission, tenant agreement, typed errors, and expected-version concurrency |

**Advisor posture after phase 8B DDL.** Zero ERROR-level findings. Total moved
169 → 186: exactly **+17**, one per new caller RPC, all the standard
gated-definer lint. No new `rls_enabled_no_policy` findings, and the private
helpers (`entitlement_move`, `upsert_financial_task`, the guard triggers) are
correctly absent from the executable list.

See `docs/phase8b-plans-entitlements.md` for the state machines, the
entitlement accounting policy, the permission matrix, and the webhook /
dunning runbooks.

Phase 8A found the ledger ending at `20260730231721` and appended:

| Version | Name | What |
| --- | --- | --- |
| `20260731163127` | desktop_billing_inventory_schema | EXTENDS the 0011 billing skeleton in place (all tables verified empty — no duplicate invoice/payment/catalog concepts). New: `suppliers`, `locations`, `tax_rates`, `product_commercial_links` (commercial/affiliate metadata kept APART from clinical eligibility), `inventory_stock` (per location/product, `on_hand`/`reserved` both `>= 0`), `inventory_ledger` (append-only movements, kind-checked, requires a non-zero delta), `invoice_events`, `payment_events`, `patient_credit_entries`, `billing_webhook_events` (`unique (provider, event_id)` — the dedup key; PHI-free and secret-free by construction). Extended: `products_services` (sku/barcode/supplier/cost/tax rate/track_inventory/reorder_threshold/catalog link/archive/version, widened kind check, org-unique SKU), `invoices` (appointment/practitioner/location, `number_int`, the seven money columns, version, finalize/void/reserve/commit timestamps, widened status check, per-org unique number), `invoice_line_items` (kind + name/sku/description SNAPSHOTS, discount + reason + authorizer, tax rate/amount, verification snapshot, sort), `payments` (status machine, method, environment `check (= 'test')` so test-mode is structurally the only allowed value, `failure_code_safe`, version, positive amount), `refunds` (status/method/authorizer/environment). Guards: `inventory_ledger_immutable`, `invoices_protect_finalized` (a finalized invoice's money is immutable; only the payment/credit/void machinery moves tracked columns), `invoice_lines_protect_finalized`, `invoice_events_immutable` (reused by refunds and credit entries), `payments_protect` (financial identity frozen at insert; no exit from a terminal state except succeeded → disputed). `review_queue_items.item_type` widened with `inventory_low_stock`. RLS: the 0011 broad FOR ALL policies REPLACED with 15 SELECT-only policies; all writes go through the definer RPCs; anon/authenticated write privileges revoked |
| `20260731180518` | desktop_billing_rpcs | 9 `private.billing_*` helpers + 22 caller RPCs granted to `authenticated` + 2 processor RPCs granted to `service_role` ONLY. Enforces on every write: `auth.uid()` identity, active membership, the financial role gate (`private.can_manage_billing` — owner/admin/practitioner), tenant agreement on every referenced row, typed errors (28000/42501/P0002/22023/40001), expected-version concurrency, and atomic payment+inventory+audit work. Tax is computed ONLY from configured `tax_rates` and snapshotted; a client-supplied figure has no code path |
| `20260731181018` | desktop_billing_guard_function_schema | moved the five guard trigger functions from `public` to `private` (`ALTER FUNCTION ... SET SCHEMA` preserves the OID, so triggers stay bound) and revoked EXECUTE from public/anon/authenticated. Advisors had flagged the public placement as anon-executable SECURITY DEFINER functions; this matches every other desktop-owned phase |
| `20260731194520` | desktop_billing_stock_threshold_sync | defect fix found by the acceptance suite: `inventory_stock` rows were created with the DEFAULT `reorder_threshold` (0), so the product-level threshold never reached them and the low-stock watchdog could never fire. The product threshold is now the source of truth — new stock rows inherit it and `upsert_billing_product` propagates changes to existing rows |

**Ledger note (recorded during the phase 8B preflight).** `apply_migration`
assigns the version server-side, so the four phase-8A files were first
committed under their authoring timestamps rather than their recorded ones.
They have been renamed to the recorded versions — this is a correctness fix,
not cosmetics: a `supabase db push` against filenames absent from the ledger
would try to apply them a second time. Separately, `20260730231721`
(`desktop_sync_claim_wire_fields`) is applied on staging but its file lives on
the still-open Desktop-sync PR branch, not on `main`; that resolves when that
PR merges and is deliberately untouched here.

Local filenames match recorded versions. All function contracts: SECURITY
DEFINER + `search_path=''` + explicit `auth.uid()` / `private.is_org_member` /
`private.can_access_patient` gates + bounded DTOs + anon/public revoked + no
PHI in error messages or audit `safe_message`.

**Advisor posture after phase 8A DDL.** Zero ERROR-level findings. Exactly 22
new security WARNs — one per caller RPC — all the generic
`authenticated_security_definer_function_executable` lint that fires for every
desktop RPC, i.e. the deliberate gated-definer architecture (invoker cannot
work: write privileges are revoked from `authenticated`), with each gate
proven by `supabase/tests/desktop_owned_billing.sql`. The two processor RPCs
are correctly absent from that list, which is itself the evidence they are
`service_role`-only. One finding WAS real and was
fixed rather than documented: the five billing guard trigger functions were
created in `public`, making them anon/authenticated-executable over PostgREST;
migration `20260731170301` moved them to `private`. No new
`rls_enabled_no_policy`, `auth_rls_initplan`, or `multiple_permissive_policy`
findings were introduced. Pre-existing findings (1 leaked-password-protection
WARN, 3 RLS-no-policy INFOs, and the standing unindexed-FK / unused-index
INFOs) are unchanged and deliberately not swept in this slice.

**Advisor posture after phase 1 DDL.** Introduced findings fixed (3 unindexed
FKs). The 3 introduced security WARNs are the generic
`authenticated_security_definer_function_executable` lint, which fires
identically for all 75 pre-existing desktop RPCs — this is the deliberate
gated-definer architecture (invoker cannot work: table privileges are revoked
from `authenticated`), and every gate is proven by the acceptance suites.
Pre-existing findings (1 RLS-no-policy INFO on `provider_callback_events`,
1 leaked-password-protection WARN, 20 auth_rls_initplan WARNs, 90
multiple-permissive-policy WARNs, 461 unindexed-FK INFOs, 89 unused-index
INFOs) are documented here and deliberately not swept in this slice.

**Advisor posture after phase 2 DDL.** Zero ERROR-level findings on phase-2
objects. The 16 new security WARNs are the same generic gated-definer lint as
above, one per new RPC — the deliberate architecture, with every gate proven
by the three acceptance suites. Phase 2 introduced NO new unindexed-FK
findings (covering indexes shipped with the tables); the unindexed-FK INFOs
matching "protocol" in the advisor output all sit on the pre-existing 0007
`supplement_protocols` / `supplement_protocol_items` / `protocol_effectiveness`
tables, which this phase does not touch. New unused-index INFOs on the phase-2
tables are expected on a schema with no production traffic yet.

**Advisor posture after phase 3 DDL.** Zero ERROR-level findings on phase-3
objects. The 20 new security WARNs are the same generic gated-definer lint as
above, one per new RPC — the deliberate architecture, with every gate proven
by the 71-check acceptance suite. Phase 3 left NO unindexed foreign keys on
the eleven Desktop-owned program tables (`desktop_program_fk_indexes` covers
the keys that predated this phase but now sit on hot query/RLS paths), and no
multiple-permissive or RLS-init-plan warnings exist on phase-3 tables (the
remaining "program" matches sit on the legacy `program_steps` /
`program_tasks` / `program_conditions` tables, untouched and without
production callers). New unused-index INFOs on phase-3 tables are expected on
a schema with no production traffic yet.

**Advisor posture after phase 4 DDL.** Zero ERROR-level findings on phase-4
objects. The new security WARNs are the same generic gated-definer lint, one
per new RPC — the deliberate architecture, with every gate proven by the
61-check acceptance suite (including the explicit anon/public execution-denied
checks). Phase 4 introduced NO unindexed-FK, RLS-init-plan, or
multiple-permissive-policy findings on the nine inbox tables; the only
advisor entries naming them are `unused_index` INFOs, expected on a schema
with no production traffic yet.

**Advisor posture after phase 5 DDL.** Zero ERROR-level findings on phase-5
objects. New entries: the standard gated-definer WARN per caller RPC (the
deliberate architecture, every gate proven by the 80-check acceptance suite,
worker RPCs correctly absent from the authenticated-executable list) and ONE
deliberate `rls_enabled_no_policy` INFO on `patient_sync_invitations` — token
hashes are never client-readable, mirroring `provider_callback_events`.
Phase 5 introduced NO unindexed-FK, RLS-init-plan, or multiple-permissive
findings on its thirteen tables; the only entries naming them are
`unused_index` INFOs, expected on a schema with no production traffic yet.

### Phase 2 state machines and immutability rules

**Appointment status machine** (authoritative in Postgres —
`private.appointment_transition_allowed`; the drawer only mirrors it):

```
scheduled  → confirmed | arrived | cancelled | no_show
confirmed  → arrived | cancelled | no_show
arrived    → in_encounter | completed | cancelled | no_show
in_encounter → completed | cancelled
completed / cancelled / no_show → (terminal)
```

- Terminal statuses have NO outgoing transitions. The only way out is
  `correct_appointment_status` — org admin only, reason required, audited as
  `appointment.status_corrected`.
- Every transition takes an optimistic `_expected_version` (SQLSTATE `40001`
  on mismatch) and an optional `_idempotency_key`; a replay returns the stored
  outcome (`already_applied: true`) instead of transitioning twice, enforced
  by a unique partial index on `appointment_status_events`.
- Rescheduling is a separate RPC — moving a visit in time is not a status
  change.
- `start_encounter` transitions the linked appointment to `in_encounter`
  itself (accepting scheduled/confirmed/arrived) so there is exactly one code
  path, not two.

**Protocol version lifecycle** (append-only; trigger-enforced):

```
draft → approved → active → superseded
protocol lifecycle: draft/active → paused ↔ active → completed | discontinued
```

- Only drafts are editable (`save_protocol_draft`, 40001 on a stale
  `_expected_updated_at`; returns `itemIds` so the client can address the rows
  it just wrote). Approved and active versions are immutable — RPC-level AND
  via `private.guard_frozen_protocol_version` / `guard_frozen_version_content`
  triggers that also block direct SQL. Corrections go through
  `revise_protocol_version`, which copies into a NEW draft; supersede never
  deletes.
- Approval freezes; activation is a separate, separately-audited action. The
  acceptance suite proves activation creates no note, invoice, message, or
  order row. Nothing sends patient instructions, places an order, charges,
  modifies medications, or writes into a note as a protocol side effect.
- Templates are org-owned and versioned; a protocol draft from an APPROVED
  template version is a fully detached copy (fresh ids), so customizing one
  never touches the other; archiving a template never touches protocols
  created from it.
- Product items pin exact catalog identity (`catalog_product_id`,
  `catalog_product_version_id`); when a label version is pinned the stored
  manufacturer + label version are the CATALOG's values, and
  `verification_status` is DERIVED by `private.catalog_verification_status` —
  the autosave payload's field is ignored (hole closed in `20260730050009`).
- `affiliate_url` is commercial metadata only (column comment says so); it
  never establishes eligibility, evidence, dosage, or safety.
- Interaction checks are deterministic and narrow: they run only when the
  product version has structured ingredient rows AND the patient has coded
  (RxNorm) medications; otherwise the item reads "Interaction review not
  completed" with the reason. A completed check reports what the checked
  sources contain — never that a product is interaction-free. Practitioner
  sign-off is its own audited action, drafts only.

### Phase 3 state machines and boundaries

**Program version lifecycle** (append-only; trigger-enforced):

```
draft → in_review → approved → published → superseded
   ↑         │
   └─ return ┘        (in_review can return to draft with a reviewer note)
```

- Drafts and in-review versions are editable via `save_program_draft` — a
  WHOLESALE replace with per-kind block validation (text body; http(s) URL for
  image/video/document/resource; 1–20 quiz questions with 2–8 options and an
  in-range answer index; check-in prompt + response type) and `40001` on a
  stale `_expected_updated_at`. Approved, published, and superseded versions
  are immutable — RPC-level AND via `private.guard_frozen_program_version` /
  `guard_frozen_program_content` triggers that also block direct SQL (DELETE
  is blocked for every version row).
- Approval freezes and explicitly does NOT publish. Publishing is a separate,
  separately-confirmed RPC that supersedes the previously published version
  WITHOUT touching enrollments pinned to it, and creates **no enrollment,
  charge, invoice, message, protocol, order, task, or note** (proven by the
  acceptance suite). Corrections go through `revise_program_version` (advisory
  lock, refuses while a draft exists, detached copy).
- Templates are org-owned and versioned; copies in BOTH directions (template →
  program, program → template) are fully detached with fresh ids. Archiving a
  template never cascades into programs created from it; archiving a program
  preserves its published history and enrollments and only refuses new
  enrollments.

**Enrollment machine** (server-enforced):

```
invited → active | cancelled
active  → paused | completed | cancelled | expired
paused  → active | cancelled | expired
completed / cancelled / expired → (terminal)
```

- Enrollment pins `program_version_id` to the exact published version at
  enrollment time; later publishes never move it. Progress rows must belong
  to the PINNED version (lesson/block checked server-side), only on active
  enrollments, append-only (trigger), with practitioner review as the only
  permitted update. Audit rows carry identifiers and kind — never payloads.

**Commerce boundary.** `program_offers` stores terms only (`price_cents`,
currency, duration, `payment_mode`). This application never processes a
payment: a `stripe`-mode offer is stored intent that the UI renders as
"Not configured" and `enroll_patient_in_program` refuses with an honest
message. A `manual_comp` enrollment requires a reason; the authorizer is the
authenticated caller recorded server-side with an audit event.

**AI boundary.** `api.programs.builderAI` is the provider-neutral Program
Builder AI contract; with no approved provider it fails closed as
not configured, and no fixture AI output exists anywhere. The versioned
`ProgramDeliveryV1` DTO (in `live-types.ts`) defines the FUTURE AI Longevity
Pro handoff shape only — nothing in this repository calls AI Longevity Pro,
transmits the DTO, or claims content reached the patient app.

### Phase 4 state machines and boundaries

**Thread status machine** (authoritative in Postgres —
`update_conversation_workflow`; the workspace only mirrors it):

```
open ↔ snoozed        (snoozing REQUIRES a wake time)
open | snoozed → resolved → open   (reopen is lawful; resolved is otherwise terminal)
```

**Message status machine** (trigger + RPC enforced):

```
draft → queued → sent → delivered      (each ← provider evidence ONLY)
draft → cancelled | superseded
queued → failed (PHI-safe reason)
inbound → (terminal; read_at is the only mutable field)
```

- Drafts are the ONLY editable message state: versioned
  (`message_draft_revisions`), optimistic (`40001` on a stale
  `_expected_version`), author-only (the sender is ALWAYS `auth.uid()` —
  no RPC takes a sender parameter, so identity cannot be spoofed). Once a
  message leaves `draft`, its body is frozen by trigger and DELETE is blocked
  — corrections are new messages.
- **Sending fails closed.** `send_message` validates consent and preferences
  (do-not-contact, declined outbound, per-channel consent — each a typed
  `22023` refusal), applies the urgent invariant, then requires a registered
  `messaging` connector. None exists: the refusal is a durable RETURNED
  outcome — draft kept, `send_refused` event persisted, NOTHING marked
  queued/sent/delivered. With a provider, send only ever reaches `queued`
  plus a `message_outbox` row (unique idempotency key; replays return
  `alreadyApplied`); `sent`/`delivered` are set exclusively by
  `record_delivery_callback` (service_role), which dedupes on
  `(provider, provider_event_id)`, only moves the projection forward,
  re-queues retryable failures with backoff state, and records terminal
  failures with a PHI-safe reason. **No code path in this repository can
  claim delivery without provider acknowledgment.**
- **Deterministic urgent invariant.** `private.detect_urgent_language` is an
  IMMUTABLE function over a FIXED dictionary ("chest pain", "can't breathe",
  "suicid", "overdose", "call 911", …). It runs on inbound recording, thread
  creation, and send; a match elevates visibility (`urgent_flag` +
  matched terms + an event) and the workspace renders an always-visible panel
  suggesting immediate human review — explicitly NOT a diagnosis and NOT a
  confirmed emergency, and entirely independent of AI availability.
- **AI triage separation.** AI output lives ONLY in `message_ai_reviews`
  (immutable content; versioned provider/model/prompt/schema + output hash),
  written ONLY by the service_role `record_ai_suggestion` boundary. A
  suggestion has zero effect until a human calls `review_ai_suggestion` with
  an explicit accept — acceptance applies through the SAME guarded workflow
  RPCs (category/priority/routing) or into the CALLER'S OWN draft
  (draft_response: never sent, never AI-attributed as sender). AI cannot
  send, resolve, refill, diagnose, order, prescribe, sign, schedule, charge,
  or suppress the urgent panel — those code paths do not exist. Patient
  message content is treated as untrusted input everywhere (adversarial
  prompt-injection tests at unit and browser level).
- **Human workflow.** Assignment, practitioner/staff queues, priority,
  category, snooze, follow-up, and resolution are optimistic-versioned RPC
  actions with append-only `conversation_events` history. "Create task"
  writes a REAL `review_queue_items` row (idempotent per message); "add to
  note" quotes the message into an UNSIGNED draft on a real encounter via the
  existing `save_note_draft` path (practitioner-gated via
  `require_clinical_actor`, idempotent, never signs).
- **Attachments** are provider-neutral METADATA plus an opaque
  `storage_ref` — no bytes in the database, no payloads in logs, and no
  guessable URLs (with `storage_provider = 'none'` the UI says
  "metadata only — storage not configured").
- **Permission matrix.** Every read/write: authenticated (`28000` if not) →
  active org membership (`private.can_handle_inbox`, `42501`) → patient
  access (`private.can_access_patient`, `42501`) → tenant agreement (thread,
  message, encounter, and patient org ids must all match) → role gates
  (clinical actor for note writes; draft author for draft edit/cancel/send).
  anon/public execution is revoked on every inbox function; all direct table
  writes are revoked — the browser can only go through the RPCs.
- **ALP delivery contract.** `src/adapters/messaging-provider.ts` defines the
  typed `MessagingProvider` interface (durable-outbox semantics above) and
  `live-types.ts` defines the versioned DTOs
  (`AlpMessagingThreadV1`/`MessageV1`/`DeliveryReceiptV1`/`ReadReceiptV1`).
  Contract ONLY: `resolveMessagingProvider()` returns null, there is no
  provider registry and no environment variable that can enable a fixture
  provider (unit-proven), and nothing in this repository calls AI Longevity
  Pro or transmits these shapes anywhere.
- **Deployment requirements** (unchanged pattern): `APP_EDITION=clinical`,
  `CLINICAL_SUPABASE_URL`/`CLINICAL_SUPABASE_ANON_KEY`, signed-in
  practitioner session. Wiring real delivery is a reviewed code change
  (implement `MessagingProvider`) PLUS a database-side `messaging` connector
  registration PLUS a worker for outbox claiming and callbacks — no
  configuration flag can shortcut it.

### Phase 5: the patient delivery & synchronization gateway

**Ownership map.**
- *Desktop-owned now:* connection + invitation lifecycle, consent scopes,
  envelope construction and queueing, the durable engine (idempotency, dedup,
  bounded retry, dead letters, cursors, conflicts, acks), inbound event store
  + review + correction overlays, all practitioner UI, all audit.
- *Future AI Longevity Pro implementation:* authenticating against
  `patient-sync/1`, invitation verification UX in the patient app, fetching/
  acknowledging outbound envelopes, submitting signed inbound envelopes,
  honoring `resource_withdrawal` and consent changes, rejecting unknown
  contract versions.
- *Future external provider work:* the service_role sync worker (claim loop,
  signed-callback verification with constant-time comparison and a replay
  window, key rotation via `signature_key_id`), invitation delivery.
- *Explicitly unavailable:* any delivery/acknowledgment claim (fails closed:
  "AI Longevity Pro connection not configured"), invitation delivery
  ("Delivery provider not configured" — the one-time code is conveyed
  manually), and the AI sync summary ("not configured", human review runs
  without it).

**Identity-linking lifecycle** (authoritative in Postgres):

```
(unlinked) -> invitation_pending -> verified <-> paused
     any live state -> revoked (terminal; re-linking = NEW connection + invitation)
```

- Linking is NEVER by email, name, phone, DOB, or fuzzy matching. An opaque
  256-bit token is returned ONCE by `create_sync_invitation`; only its sha256
  is stored. Tokens expire (7 days), are single-use, org/patient scoped, and
  superseded by any newer invitation. `verify_sync_invitation` (worker
  boundary) binds the external system's authenticated subject; a partial
  unique index refuses a subject already bound elsewhere (forgery/reuse) and
  a second live connection per patient.
- Revocation is immediate: pending invitations die, undelivered exports are
  cancelled, `record_sync_inbound` refuses with `42501`, and history is
  preserved — never deleted. Optimistic concurrency (`_expected_version`,
  `40001`) guards every lifecycle action.

**Consent scopes.** Eleven independent, versioned scopes (programs,
protocols_supplements, nutrition, appointments, messaging, forms_checkins,
symptoms_adherence, wearables, lab_summaries, billing_links,
research_n_of_1). A grant records the presented artifact + version,
jurisdiction where available, method, and representative authority. A
revocation (practitioner or patient-app; the newest valid revocation wins
immediately) cancels queued exports for THAT scope only and blocks future
sync for it, while other scopes continue; nothing historical — signed notes,
prior records, audit evidence — is ever deleted. `research_n_of_1` is fully
separate from every care-delivery scope; nothing infers it.

**Authority / conflict matrix** (enforced server-side):

| Data | Authoritative side | On conflict |
| --- | --- | --- |
| Practitioner-approved programs / protocols / nutrition content | Desktop | newer version supersedes undelivered envelopes; withdrawal event revokes |
| Patient adherence, symptoms, quiz/check-in responses | Patient app (original submission, immutable) | corrections are versioned overlays, never mutations |
| Consent revocation | Newest valid revocation | applies immediately, both directions |
| Appointment scheduling | Desktop scheduling system | app sends `appointment_request` for human review |
| Delivery / read receipts | Receiving provider | forward-only projection; stale evidence recorded but never demotes |
| AI summaries | Nobody (derived) | reviewable draft only; stale when sources change |
| Stale/out-of-order inbound versions | — | explicit `sync_conflicts` row + review task; resolution requires a note and never overwrites either original |

**Retry / dead-letter behavior.** Failures back off at `2^attempts` minutes
capped at 24h; the 8-attempt threshold (or a provider `rejected`) dead-letters
the envelope, records `sync_dead_letters`, and opens a REAL `sync_review`
review-queue task. Manual retry requires an authorized role (owner/admin/
practitioner), a reason, and is audited; the dead-letter row keeps the retry
trail. Operator reconciliation: Integrations → dead-letter queue → reasoned
retry (or withdraw the resource); conflicts and pending inbound reviews are
worked from the chart's Patient App tab or `/tasks`.

**Provider approval requirements.** An approved provider is (1) a reviewed
`PatientSyncProvider` implementation in code AND (2) a CONNECTED
`alp_patient_sync` connector row in the database. `resolvePatientSyncProvider()`
returns null, there is no registry, and no environment variable is read —
an env flag is never security or compliance approval (unit-proven). Without
the connector, `queue_sync_export` refuses durably and even the service_role
worker cannot claim.

**AI Longevity Pro implementation guide.** Implement `patient-sync/1`
(`PatientSyncOutboundEnvelopeV1` / `PatientSyncInboundEnvelopeV1` in
`src/adapters/live-types.ts`): verify the invitation token exactly once and
present the external subject; treat every envelope as at-least-once (dedupe
on `eventUid`/`idempotencyKey`); validate `payloadHash`; acknowledge with
provider-unique event ids; submit inbound envelopes signed (the worker
verifies with constant-time comparison inside a replay window and records
`signature_key_id`); apply `resource_withdrawal`; honor consent changes;
reject unknown contract versions. **The AI Longevity Pro repository was not
modified, called, branched, or committed to by this phase.** No real delivery
is claimed until that application implements and authenticates against this
contract.

**Security & PHI-safe logging.** All the standing gates (auth.uid(), active
membership, patient access, tenant agreement across every reference,
anon/public revocation, direct-write revocation, pinned `search_path`, typed
SQLSTATEs) plus: token hashes unreadable by clients (deny-all RLS), payload
size limits (64 KiB inbound, 16 KiB overlays), evidence timestamp windows,
attachment-by-reference only, no service-role key in any browser or request
path (worker RPCs are unreachable from the app), audit `safe_message` never
carries message bodies or payloads, and security-relevant connection history
lives in `sync_connection_events` separately from clinical audit. No HIPAA,
SOC 2, FDA, "validated", "encrypted", or BAA status is claimed anywhere.

**Deployment.** Unchanged base requirements (`APP_EDITION=clinical`,
`CLINICAL_SUPABASE_URL`/`CLINICAL_SUPABASE_ANON_KEY`, signed-in
practitioner). Going live additionally needs the reviewed provider
implementation, the `alp_patient_sync` connector registration, and the sync
worker — three separate acts, none of them a flag.

### Phase 6A: the patient sync worker & contract verification

**AI Longevity Pro is not connected.** Nothing in this phase talks to a real
patient application. The `sync_contract_fixture` provider is deterministic
TEST infrastructure that proves the `patient-sync/1` contract end to end; it
performs no network I/O, refuses every deployed environment, and every
surface that shows it says so. The real receiver is Phase 6B and requires
separate explicit authorization.

**Worker architecture.** The worker is a separately runnable process —
`node scripts/sync/worker.mjs` (`npm run sync:worker`) — living under
`scripts/sync/` (plain `.mjs`), structurally outside every browser bundle and
every Next.js import graph. Modules: `contract.mjs` (strict patient-sync/1
DTO validation — unknown fields, wrong versions, malformed hashes, oversize
payloads all fail closed as `contract` errors), `errors.mjs` (the failure
taxonomy), `backoff.mjs` (bounded exponential backoff + jitter),
`circuit.mjs` (closed/open/half-open breaker), `hmac.mjs` (callback
signatures), `redact.mjs` (allowlist-only structured logging), `deploy-guard.mjs`
(fixture refusal), `fixture-provider.mjs` (the labeled test provider),
`supabase.mjs` (service-role RPC client that refuses browser contexts and
missing credentials), `worker-core.mjs` (the cycle), `callback-server.mjs`
(the signed inbound boundary), `worker.mjs` (entry point). 41 unit tests run
in the standard vitest suite.

**One worker cycle** (state authority stays in PostgreSQL; the worker holds
nothing but the current batch, so restarts lose, duplicate, and falsely
complete nothing):

```
claim_sync_outbound (lease + SKIP LOCKED, expired-lease reclaim)
  └─ per envelope:
       validate patient-sync/1 DTO ──contract violation──▶ rejected (dead letter)
       recheck_sync_export (consent/connection/supersession AT DELIVERY TIME)
         └─ refused ──▶ durable cancel by the DATABASE; provider never called
       circuit breaker gate ──open──▶ skip; lease expires and is reclaimed later
       provider.deliver(envelope) ──▶ evidence via record_sync_delivery ONLY
         failures: retryable ──▶ failed (+ backoff, Retry-After honored)
                   permanent/contract/security/consent ──▶ rejected, NEVER retried
record_sync_worker_cycle (PHI-free counts + circuit state)
```

Only provider evidence can mark an envelope delivered or acknowledged — the
worker cannot, the UI cannot, and a crash after delivery re-delivers into the
database's `(connection, provider_event_id)` dedup because fixture evidence
ids are deterministic per idempotency key.

**Envelope states.** `queued → sending (leased) → delivered → acknowledged`,
with `failed` (bounded backoff), `dead_letter` (threshold or terminal
rejection; REAL review task), `superseded` (newer version existed before
delivery), and `cancelled` (consent revoked, connection disabled, or a
reasoned practitioner discard — `cancel_sync_event` requires an authorized
role and a reason, and is audited). An explicit re-share after
cancelled/superseded mints a NEW envelope generation (`:rN`); a consent
re-grant alone never silently resends anything.

**Callback security** (the worker's `--callback-port` boundary; the ONLY
process holding these secrets): POST `/sync/callback`, `application/json`
only (415), 64 KiB cap (413), HMAC-SHA256 over `v1:<timestamp>:<nonce>:` +
the RAW bytes verified with a constant-time comparison BEFORE any parsing
(401), key resolution by `x-sync-key-id` (rotation-ready), ±5 min timestamp
tolerance, nonce replay refused durably via `register_sync_callback_nonce`
(409), sanitized `{ok}`/`{error:{code}}` responses, and allowlisted logs that
never carry bodies, payloads, tokens, or PHI. Delivery-evidence callbacks
route to `record_sync_delivery`; inbound envelopes route to
`record_sync_inbound` (hash-validated, consent-gated, review-not-chart).

**Posture** (`get_org_sync_operations().posture`, shown in Integrations):
`disabled` (no connector — queueing and claiming fail closed) → `fixture`
(the `sync_contract_fixture` connector; every surface carries "Deterministic
contract fixture — TEST behavior only. This is NOT a real AI Longevity Pro
connection") → `approved` (`alp_patient_sync`, which takes precedence). The
fixture can never run deployed: Railway, Fly, Vercel, Render, Heroku, Cloud
Run/Functions, AWS/ECS, Azure, Kubernetes, generic `DEPLOYMENT_ENV`/
`DEPLOY_ENV` markers, and `NODE_ENV=production` all refuse with
`fixture_refused_deployed`, and there is deliberately NO override flag.
`SYNC_PROVIDER=alp` (or anything but `none`/`fixture`) is refused by the
entry point until Phase 6B is separately authorized.

**Environment variables** (names only; worker process ONLY — none are read
by the web application, none may ever appear as `NEXT_PUBLIC_*`, and the
bundle scan greps built client chunks for service-role material):
`SYNC_WORKER_SUPABASE_URL`, `SYNC_WORKER_SERVICE_ROLE_KEY`,
`SYNC_WORKER_ORG_ID`, `SYNC_PROVIDER` (`none` | `fixture`),
`SYNC_FIXTURE_SCENARIOS`, `SYNC_WORKER_BATCH`, `SYNC_WORKER_INTERVAL_MS`,
`SYNC_WORKER_LEASE_SECONDS`, `SYNC_CALLBACK_SECRET`, `SYNC_CALLBACK_KEY_ID`.

**Deployment topology.** The web application and the worker are separate
processes with separate credentials: the app ships with anon-key access and
RLS-guarded RPCs only; the worker (wherever it runs) holds the service-role
key and is the only path to `claim_sync_outbound`, `recheck_sync_export`,
`record_sync_delivery`, `record_sync_inbound`, `record_sync_worker_cycle`,
and `register_sync_callback_nonce` (all EXECUTE-revoked from anon AND
authenticated). `/api/health` answers `{ok:true}` from the app alone —
worker absence never makes the web application unhealthy, and
`SYNC_PROVIDER=none` exits idle by design.

**Runbook.**
- *Is the worker healthy?* Integrations → "Worker & circuit": last cycle
  counts, lease reclaims, circuit state, oldest queued age. No cycle row +
  growing queue age = the worker is not running.
- *Circuit open?* The provider is failing repeatedly; envelopes stay leased
  or queued and are reclaimed safely. Fix the provider side; the breaker
  half-opens and closes on the next successes. Nothing needs manual state
  surgery.
- *Dead letters:* Integrations → dead-letter queue → reasoned Retry, or the
  chart's Patient App tab → reasoned Retry / Discard. Both require a reason
  and are audited.
- *Replay/incident:* every delivery attempt, provider evidence row, worker
  cycle, and connection event is append-only; reconcile from
  `sync_delivery_events` (dedup key `(connection, provider_event_id)`) and
  `sync_worker_cycles`. Nonce replays and signature refusals appear in worker
  logs as `callback_replay_refused` / `callback_refused` with codes only.
- *Stuck lease:* leases expire (`SYNC_WORKER_LEASE_SECONDS`, default 120s)
  and the next claim reclaims them as fresh attempts — visible as
  `leaseReclaims` in telemetry.

**Phase 6B readiness checklist** (all still required before any real
connection):
1. Separate explicit authorization to modify AI Longevity Pro.
2. A reviewed `alp` provider implementation (HTTP adapter satisfying the
   fixture-proven `deliver`/evidence semantics) behind the same entry point
   that today refuses `SYNC_PROVIDER=alp`.
3. AI Longevity Pro implementing `patient-sync/1` per the Phase 5
   implementation guide (verify-once tokens, at-least-once dedup, hash
   validation, signed callbacks, withdrawal + consent honoring).
4. The `alp_patient_sync` connector registration (database act, reviewed).
5. Real callback secrets provisioned to the worker only, with key ids and a
   rotation plan.
6. Re-run: both DB acceptance suites, the full browser battery, advisors,
   and the bundle scan — with the fixture suites left fully intact.

### Phase 8A: billing, checkout, Stripe test-mode, catalog & inventory

The Desktop-owned financial workflow: `appointment → checkout → invoice →
payment → receipt → inventory movement → reconciliation → audit`. Production
card processing is NOT enabled and insurance claims are deliberately out of
scope.

**Invoice state machine.**

```
draft ──finalize──▶ open ──payment/credit──▶ partially_paid ──▶ paid
  │                   │                            │              │
  └──void──▶ void ◀───┘ (unpaid only)              └──refund──▶ partially_refunded ──▶ refunded
```

A `draft` has no financial or inventory effect at all. Only an unpaid `draft`
or `open` invoice can be voided; once money has moved the path is a refund.
`uncollectible` exists in the check constraint for a future write-off flow and
is not reachable from any RPC in this phase.

**Money rules.**

- Integer **minor units** end to end: `*_minor` columns, `*Minor` wire fields,
  `src/lib/money.ts` helpers. No float ever holds an amount.
- **Tax is never client-supplied.** `save_invoice_draft` reads the product's
  configured `tax_rates` row, computes half-up on the discounted base, and
  snapshots both `tax_rate_bps` and `tax_minor` onto the line. The wire
  contract has no tax field, and `billing.live.ts` projects each line to the
  fields a client may propose, so a stray amount is dropped at the adapter
  rather than merely ignored by the database.
- **The browser never asserts money moved.** `start_card_payment` returns
  `{paymentId, amountMinor, currency}` — there is deliberately no success
  field to render.
- Discounts require a reason and are attributed to the authorizing user.
- A finalized invoice's money and lines are immutable at trigger level; line
  snapshots mean later catalog edits never rewrite history.

**Inventory accounting policy.** (This is the policy the RPC migration header
refers to.)

| Event | Effect on stock |
| --- | --- |
| `draft` | none — a draft never touches inventory |
| `finalize` → `open` | **RESERVE** tracked lines (`reserved += qty`); insufficient availability is a typed `40001`, never a negative number |
| full settlement | **COMMIT** the sale exactly once (`on_hand -= qty`, `reserved -= qty`), guarded by `invoices.inventory_committed_at` |
| `void` (unpaid) | **RELEASE** the reservations |
| refund | **nothing** — a refund returns money, not goods |
| `return_inventory_stock` | the ONLY restock path: reason AND condition required; only `resalable` re-enters sellable stock, `damaged` is ledgered without adding any |
| services / non-tracked items | never touch stock |

Stock has no "set the number to X" write. It moves only through receipts,
reasoned adjustments, sales, and returns, so `inventory_ledger` always
explains the current figure. Selling a tracked item requires a location.

**What was actually exercised (read this before trusting any Stripe claim).**
Phase 8A made **no Stripe API request and verified no signed webhook**. There
is no `stripe` dependency, no call to `api.stripe.com`, and no signature
verification anywhere in the tree. What shipped is the *persistence and
ingest boundary*: the payment/refund/webhook-event tables, the settlement
state machine, dedup and agreement rules, and the `service_role`-only RPCs —
all verified with **deterministic fixtures**. That foundation is real and
tested; an operational processor is not, and no screen may imply otherwise.
Phase 8B adds the real signature-verifying, disabled-by-default adapter.

**Payment boundary.** Manual methods (`cash`, `check`, `bank_transfer`,
`external`) are recorded by a practitioner as money already taken; an
idempotency-key replay is a typed conflict, not a second charge. Card
payments are **test-mode only** (`environment` is check-constrained to
`'test'`), and the flow below describes the boundary's contract, not a
connected processor:

1. the browser calls `start_card_payment`, which creates a **PENDING** row and
   refuses a second in-flight card payment for the invoice;
2. the server-only boundary attaches the processor reference
   (`attach_payment_processor_ref`, `service_role` only, attach-once);
3. `record_billing_webhook` (`service_role` only) settles it — dedup FIRST via
   `unique (provider, event_id)`, then tenant/amount/currency agreement, then
   the event-type state machine.

**Refusals are recorded rows, not silent drops.** A replayed event answers
`duplicate`, a mismatched amount `refused`, an event arriving after a terminal
state `out_of_order`, an unknown type or unmatched reference `ignored` — every
one persisted in `billing_webhook_events` and visible on the reconciliation
panel. Neither processor RPC is reachable from any browser route or client
module, which `src/adapters/payments-boundary.test.ts` proves from the outside.

**Low-stock watchdog.** Crossing the reorder threshold opens exactly ONE open
`inventory_low_stock` review task per product, naming the triggering location.
It never purchases anything and never duplicates while one is open.

**Permission matrix.** Reads require authentication + active membership (+
patient access for patient-scoped reads), so front-desk **staff can read** the
workspace and invoices. Every write additionally requires a financial role —
owner, admin, or practitioner via `private.can_manage_billing` — so staff
cannot alter the catalog, take payment, or move stock. Anonymous callers get
`28000`; a wrong tenant or an insufficient role gets `42501`.

**No clinical side effects.** Billing creates no note, message, protocol,
appointment, enrollment, or conversation — asserted directly by the acceptance
suite.

**Deployment requirements.** Nothing beyond the standard clinical Supabase
configuration: this phase adds no environment variable, no worker, and no
outbound network call. A production processor (keys, PCI review, a live
`environment` value, and a signed-webhook receiver) is required before any
real charge and is deliberately absent here.

## Deprecations

- `NEXT_PUBLIC_USE_LIVE_API` — constant `true`; not consulted anywhere.
  Remove the remaining imports opportunistically; delete the export when none
  remain.
- `api.calendar.getSchedule`, `api.patients.summary` — refusing aliases kept
  one phase so stale callers fail loudly; delete in phase 3.
- `api.schedule.updateStatus` (`update_appointment_status`) — now a thin
  delegate over `transition_appointment` with no version/idempotency
  protection. New code must call `api.schedule.transition`; delete the
  delegate once the last caller migrates.

## Phase 6B recommendation

Phase 6A finished the runtime half on the desktop side: the durable worker,
the lease/recheck/evidence loop, the signed callback boundary, and the
deterministic contract fixture that proves all of it without touching a real
patient application. The single remaining step for live sync is **the AI
Longevity Pro receiver itself** — a separately authorized Phase 6B spanning
the other repository, per the readiness checklist above. Until then the
desktop needs zero further changes for sync to go live.

Desktop-only alternatives in priority order: **billing & payments
persistence** (invoices as rows behind an honest not-configured payment
boundary, unlocking the `billing_links` scope), **nutrition persistence**
(unlocking the `nutrition` scope and its already-defined envelope type), or
**reports** (access-scoped aggregates over the seven real domains). The AI
sync summary and inbox copilot both wait on a governed AI provider decision;
their human-review gates are already live.
