# The last five unverified route-authority cells (16 October)

The inventory is in `src/server/route-authority-inventory.ts`. Its test pins the exact list of gap and unverified cells.

| | Count |
| --- | --- |
| Unverified, before this pass | 5 |
| Unverified, after this pass | **4** |
| Refused | 57 → 58 |
| Gaps | 4, unchanged |

The `token_lifetime` / `refused` / `gap` / `unverified` distinctions are unchanged, and no cell was relabelled without
a test.

## 1. `unconverted_claims_families / legacy_claims / removed_membership` is now `refused`

The family was traced path by path: every Desktop route, its upstream, the SQL it reaches, and that SQL's check. A
test now proves, for each route, that a removed membership (`organization_memberships.status='suspended'`; there is
no other removal state) is refused on the next request, while the token still names the clinic.

- The service's `set_request_context` checks only the identity row.
- Each operation then re-reads the membership through `has_clinical_role`, `is_active_member` or
  `require_clinical_patient`, before it reads the request.
- Every test first succeeds for the same person while the membership is active, so the refusal is the membership's,
  not the request's.

These tests pass before and after this pass. They are **coverage of behaviour that was already correct**, not a
repair.

| Route(s) | Operation(s) | Check | Evidence |
| --- | --- | --- | --- |
| `live/scribe/capture/[operation]` | segment with an already-issued capture token; state; readiness | `lock_recording_encounter` → `require_clinical_patient` | `recording-transcription.database.test.ts` (new) |
| `live/scribe/transcription`, `live/scribe/drafting` | transcript list; proposed-note list | `lock_owned_recording` | same (new) |
| `live/scribe/authority` | recording participants | `lock_recording_encounter` | `unconverted-families-clinic-status.database.test.ts` (existing) |
| `live/recording-cleanup-*` | operator check | membership, clinic and assignment join | `encounter-recording-authority.database.test.ts` (existing) |
| `live/calendar-connection` | read; busy sync (checked before the request is read) | `has_clinical_role` | `unconverted-families-removed-membership.database.test.ts` (new) |
| `live/ask-alp/configuration` | configuration status | `has_clinical_role` | same (new) |
| `live/consult-requests` | links; queue and contact | `assert_consult_workforce` | same (new) |
| `live/consult-retention` | settings | `assert_practice_workforce` | same (new) |
| `live/care-governance` | disputes; content revisions | `assert_care_workforce` | same (new) |
| `live/practice-outcomes` | ledger; report | `assert_practice_workforce` | same (new) |
| `live/protocol-carts` | list | `assert_practice_workforce` | same (new) |
| `live/note-templates` | templates; drafting context | `assert_practice_workforce` | same (new) |
| `live/patient-notification-settings` | the clinic's read-only view (BLOCKED candidate) | `is_active_member` | `patient-notifications.database.test.ts` (new) |
| `live/lab-attestations*` | review | membership re-read | `lab-attestation-review.database.test.ts` (existing) |
| `live/clinic-records` | workforce actions | membership re-read | `clinic-record-privacy.database.test.ts` (existing) |
| `live/privacy-operations` | assigned queue | the operator assignment (current authority, not membership); revoking it refuses | `unconverted-families-clinic-status.database.test.ts` (existing) |

The intake functions (`intake_form_admin`, `intake_packet_workforce`) have no Desktop caller. Their check is tested
anyway.

**Residuals recorded, not inventory cells.** None of these is a Desktop route.

- **Ask ALP.** The identity API also accepts the workforce chat actions `active_prompt` and `active_rules`, which read
  global prompt configuration without a membership check. The Desktop client never sends them, and they carry no
  clinic data. A direct call with an unexpired token still reads them until the token expires.
- **Calendar.** `external_calendar_request` also refuses a suspended clinic; `external_calendar_busy_sync` does not.
  That belongs to the family's `suspended_clinic` gap, which stays a gap.

## 2. `transitional_lab_documents / legacy_claims` × 4 stay `unverified`

The four cases are unapproved account, suspended clinic, removed membership and stale token.

The Desktop's lab upload and original-document routes call `TRPC_BASE_URL` `/api/clinical/labs/upload` and
`/api/clinical/labs/document/:id`. That host is not in this repository.

**Where its source was:**

- The last source that served those routes was V2's `expo/backend/labs/upload-route.ts`, mounted in
  `expo/backend/hono.ts`. It was added in `59e1dc0` and last changed in `948f46c` (16 July).
- It decided under Supabase row-level security with the caller's JWT, using no service role.
- It was **deleted at `b2850a2` (22 July, "Restore app to pre-EMR-platform state")**. That commit is an ancestor of
  current V2. The file is on no current branch head.

**Why it stays unverified.** The deployed build behind `DEPLOYED_TRPC_BASE_URL` is unknown. A test of deleted source,
or of today's Supabase policies, would be evidence about code that may not be what answers, so the cells stay
`unverified`.

**Exact hosted four-persona probe, for Codex.** Run it against the deployed transitional host on an approved, reviewed
target, with fictional accounts and a fictional PDF only.

1. **Personas.** Prepare four, each with a fresh ID token:
   1. an account with no clinic membership;
   2. an active practitioner of clinic S, after S is suspended (`organizations.status='suspended'`);
   3. a practitioner of clinic R whose membership is set to `suspended` after their token was issued;
   4. a practitioner of clinic R whose token was issued before any change, used for a known lab document of R. This
      checks that a token that is still valid reaches nothing once its authority is gone; run it after the change
      for persona 3.
2. **Requests.** For each persona:
   - `POST /api/clinical/labs/upload` (multipart, a fictional patient of the persona's clinic, a one-page fictional
     PDF);
   - `GET /api/clinical/labs/document/<a known fictional document id of that clinic>`.
3. **Expect.**
   - every answer is 401 or 403;
   - no `lab_documents` row and no storage object are created;
   - no PDF bytes are returned;
   - no audit row records a successful view;
   - no token appears in logs.
4. **Control.** The same requests by an active member of an active clinic succeed.
5. **Record.** For each persona and request, record:
   - the host's build identifier (commit or image digest), which the probe must read first;
   - the response status;
   - the row and object counts before and after.

Only that record, from the deployed host, can move these cells.

## 3. What did not change

- The four suspended-clinic `gap` cells.
- Every `token_lifetime` cell. A token stays usable until API Gateway refuses its `exp`; nothing behind it answers
  after a removal, which is what `refused` records.
- `database_current` rows.
