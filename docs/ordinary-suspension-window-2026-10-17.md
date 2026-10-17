# Ordinary-suspension sessions, bounded at the authority boundary

**Status: BLOCKED.** This is a source candidate only. Nothing was applied, registered or deployed. The TypeScript release
switch `ORDINARY_SUSPENSION_WINDOW_RELEASE` is `blocked`, so every service still calls the seven-argument entry exactly
as deployed. All evidence here is local: PGlite, plus a disposable PostgreSQL 16 cluster. There is no hosted, Aurora,
Cognito or Data API evidence.

## 1. The rule, and why the database could not apply it

The owner's rule for an **ordinary** clinic suspension:

- A practitioner session that was already valid at the suspension may continue only until that token's own expiry.
- A refreshed or new token does not inherit that allowance, and nothing extends it.
- New consent grants stay blocked.
- A suspected compromise is a different event, the emergency revocation, and is refused at once.

Before this candidate, every legacy workforce request reached `clinical_private.set_request_context` with the same seven
values. None of them was a time, and no clinic recorded when it was suspended. So the database could not tell a session
opened before a suspension from one refreshed after it (`ordinary-suspension-continuity.database.test.ts`). Two things
follow:

- **As deployed:** both continue, without any bound.
- **Under the BLOCKED clinic-status successor:** both end at once. The owner has ruled that out.

## 2. The contract (the smallest one found)

`infra/aws-clinical-core/source-candidates/workforce-ordinary-suspension-window.sql` sits on its parent, the emergency
revocation successor (prosrc `3ee98d29…`). Its preserving rollback is `workforce-ordinary-suspension-window-rollback.sql`.

1. **A recorded suspension time.**
   - `clinical_private.organization_status_transitions` gets one row per change of `clinical_core.organizations.status`.
   - A trigger writes it in the changing transaction, with the database's own `clock_timestamp()`.
   - The table is append-only, even for the table owner. No API role can read or write it.
   - Nothing a caller sends can set that time.
2. **A second entry.** It takes the same seven values plus three more:
   - `_token_issued_at` and `_token_expires_at`: the verified ID token's `iat` and `exp`, in NumericDate seconds;
   - `_access`: `read` or `write`.

   The seven-argument entry is the same call with no evidence. Both call one private function,
   `admit_request_context`, which no role but its owner may execute.
3. **The rule.** It applies to a workforce `clinical_data` or `identity_link` request, after the clinic row is
   share-locked. That lock makes a suspension in flight be waited for, then re-read.

   | Clinic | Without evidence (7 args) | With evidence (10 args) |
   | --- | --- | --- |
   | active | as the parent | as the parent, but malformed or expired evidence is refused |
   | suspended | **refused** | see the list below |
   | archived | refused | refused |

   With evidence in a suspended clinic, a request is **admitted read-only** only when all of these hold:
   - the clinic's latest recorded transition is to `suspended`;
   - the token was issued at least 60 seconds before that transition;
   - the statement clock, read after the lock wait, is before `exp`;
   - the access is `read`.

   Once admitted:
   - The transaction is made read-only. `statement_timeout` and `lock_timeout` are set to the time left.
   - A declared write is refused as `ordinary_suspension_write_held`, which is held, not failed (`operation_refused`).

   Anything else is refused as `request_context_refused`.

   **Unchanged:**
   - workforce `consent_management`: the retention sweep, erasure recovery, recording cleanup, and the practitioner's
     own consent decisions, which the consent-decision candidate governs;
   - every consumer request.

   Evidence, when it is sent, is checked whatever the purpose: malformed or expired evidence is refused for
   `consent_management` and consumer requests too. Only the window itself is limited to `clinical_data` and
   `identity_link`.

**Why `iat` and not `auth_time`.** A Cognito refresh keeps the original `auth_time` and issues a new `iat`. The rule is
about the token that was valid at the suspension, so the candidate reads `iat`.

## 3. Trace: issuer to SQL

| Step | Where | What it does with the times |
| --- | --- | --- |
| Issuer | Cognito workforce pool | Signs `iat`, `exp` and `auth_time` into the ID token. The ID-token lifetime is pool configuration; Codex verifies it. |
| Verification | API Gateway HTTP API JWT authorizer | Verifies the signature and `exp` (AWS behaviour, not in this repository). It passes the claims as `requestContext.authorizer.jwt.claims`. |
| Desktop | Next.js server (`src/adapters/auth.server.ts`, `src/server/session.ts`) | Forwards the bearer token only. It never sends a time; no header or body field is read for this. |
| Lambda entry | `aws-identity-api.ts` `contextFromClaims`, the deployed legacy path (`aws-production-clinical-lambda.ts`) | Now reads `iat` and `exp` from the verified claims into `context.tokenWindow`: whole seconds, lifetime 5 minutes to 1 day, else absent (`tokenWindowFromClaims`). |
| Dispatch | `aws-production-desktop.ts` `run` (the Desktop RPCs and table reads) and `aws-clinical-state.ts` `run` (the patient list, lab documents and observations, lab imports and specimen context, lab review) | With the switch at `qualification`: the ten-argument entry, with `access` from a fixed list. Without evidence: refused before the database. Switch `blocked`: unchanged. |
| SQL | `clinical_private.admit_request_context` | The rule in §2, with the database clock. |

`aws-production-clinical-api.ts` was examined and left unchanged: no Lambda bundles its handler.

**The read set** (`PRODUCTION_DESKTOP_READ_RPCS`) contains only RPCs whose SQL function is STABLE with no write or row
lock. A test checks this against the schema, and every other RPC is a write. An unlisted read is therefore held, never
written. A write mislabelled as a read cannot land either, because the transaction is read-only.

**Callers that carry no evidence.** They stay on seven arguments, so in a suspended clinic they are refused once the
candidate is applied:
- the compatibility fallback;
- the production care-messaging, care-connection and clinic-records workforce calls;
- the recording family;
- the qualification program host;
- every synthetic-only family.

Converting each one is a per-family decision. `database_current` is unchanged: its setter already refuses a suspended
clinic at once, which is stricter than the rule allows.

## 4. Threat model

| Threat | What happens |
| --- | --- |
| **Forged times** | The times come only from the authorizer's verified claims. A browser, header or body value is never read (unit test). Forging one needs the Lambda's own identity, which could forge the seven values today. The database refuses impossible evidence anyway: a lifetime outside 5 min–1 day, `iat` in the future, `exp ≤ iat`, non-integers. |
| **Missing times** | Refused in a suspended clinic, never guessed. An active clinic is unchanged. Under `qualification` the service refuses a workforce request without evidence before the database. |
| **Stale refresh** | A refreshed token's `iat` is after the suspension, so it is refused. That includes a refresh made while the suspension was in flight (native). |
| **Clock skew** (Cognito against Aurora) | A token issued within 60 seconds of the recorded suspension is refused, which is the conservative side. Expiry uses the database clock, with no allowance. |
| **A statement held on a lock** | The clinic row is share-locked first. The expiry is then read from `clock_timestamp()` *after* the wait, so a token that expired while waiting is refused (native). Inside the window, every statement and lock wait is bounded by the time left (native: cancelled at about 3.4 s of 4). |
| **Issued before, used after expiry** | Refused (PGlite and native). |
| **Writes during the window** | A declared write is held. A write sent as a read fails on the read-only transaction (PGlite and native). |
| **Suspended before the candidate** (no transition row) | Refused: no evidence. |
| **A transition row contradicting the status** | Refused (PGlite). |
| **Archived clinic** | Refused, with no window. |
| **Emergency revocation during the window** | Refused at once, because the identity check comes first. A request racing a pending revocation waits for it and is refused (native). |
| **Sibling clinic** | Not held back by a suspension in flight. The window opens nothing outside its own clinic (PGlite and native). |
| **A replayed, unexpired, pre-suspension token** | Admitted read-only until `exp`. This is exactly the allowance the rule grants; the bound is the token's own lifetime. |

## 5. Evidence

| Kind | Result |
| --- | --- |
| **Failing before**, on the parent, PGlite (`ordinary-suspension-window.database.test.ts`) | After a suspension, the seven values read and write: one test. No ten-argument entry and no transition table exist. |
| **Failing before**, native scenario 1 | The same, on PostgreSQL 16: three DEFECT checks. |
| PGlite, the candidate | 21/21. Covers: pin, transitions, the active clinic, malformed and expired evidence (expired refused for any purpose, consent management included), the window (read-only, timeouts), a held write, a disguised write, refresh and skew, expiry, missing evidence, unrecorded suspension, re-suspension, archived, sibling clinic, emergency revocation, consent management, the read set against the schema, the production adapter over the database (blocked and qualification), guards, rollback ordering. |
| Native (`scripts/qualify-ordinary-suspension-window-native.mjs`) | 8 scenarios, 23 checks, all passing (`docs/evidence/2026-10-17-ordinary-suspension-window-native-e28a3c9e.json`, on the candidate with the any-purpose expiry rule; the earlier `…-1dc1da19.json` predates it). |
| Unit (`ordinary-suspension-window.test.ts`) | 9/9: evidence from claims only, entry SQL per switch, access classification, refusal before the database. |
| Existing suites touched | 175/175 (identity API, clinical state, production adapter, current-identity, membership discovery, emergency revocation); route inventory and continuity matrix 225/225. |

## 6. Identities

| Artifact | SHA-256 |
| --- | --- |
| `workforce-ordinary-suspension-window.sql` | `94b25a4a7557f4256e6b678c8d338160afcf98371787aadd90a88c2154b3f90b` |
| `workforce-ordinary-suspension-window-rollback.sql` | `efd8665c81b90599913074721818b6cbdc6c45fc47df54318da1c6cb51184466` |
| prosrc of the seven-argument entry | `359837b0d0f46046fae4ea842ddef0b02d9cb284294ac76b30bc442c126370d1` |
| prosrc of the ten-argument entry | `f1f07d424d6f1b2da2fbf3a381b3e0eba90a13f24712bacb753ccb4cecf2933d` |
| prosrc of `admit_request_context` | `8ccbfd1375c1e11ce1205140219fc56ccfbf87da186d905b991e418f94252b32` |
| Required parent prosrc (the emergency revocation's entry) | `3ee98d29830ee366a1c670c236cbf018b710eb7dbbc48d3ee090e7d66c36097b` |

**Ordering:**
- It refuses the deployed entry (`36d00be9…`) and the clinic-status successor (`4187ce78…`) as parent, and the
  clinic-status successor refuses it.
- Roll it back first: the emergency revocation's rollback refuses while this is applied (PGlite).

## 7. Decisions this does not take (held, explicit)

1. **New clinical writes in a suspended clinic** stay held: the window is read-only. Whether any write may continue
   is the owner's open question.
2. **Practitioner withdrawal** arrives as `consent_management`, which is not windowed. A withdrawal by an active
   clinical member is admitted after the token has been refreshed too. This is the consent-decision candidate's
   behaviour (D2, withdrawals only); whether it should be time-bounded is a decision for the owner.
3. **Archived clinics** get no window.
4. **The 60-second skew margin and the 1-day lifetime bound** are source constants. Codex verifies the pool's actual
   ID-token validity: the allowance is at most that lifetime.
5. **Which unconverted workforce families** (§3) should carry evidence, if any.
6. **D3, D4 and D5** are untouched.

## 8. Codex hand-back (ordered, not run)

1. On the target, verify:
   - the emergency revocation is applied, with entry prosrc `3ee98d29…`;
   - the ledger;
   - both file hashes above.
2. Apply the window candidate to **isolated fictional qualification Aurora** only.
3. Repeat the eight native scenarios there. Then roll back, and confirm the parent prosrc byte for byte and that the
   transition rows remain.
4. Read the workforce pool's `IdTokenValidity` and `RefreshTokenValidity`. Confirm that the HTTP API authorizer passes
   `iat` and `exp` in the claims, and in what form.
5. With fictional tokens on the qualification stack, check five cases:
   - a token issued before the suspension reads until `exp`;
   - a refreshed token is refused;
   - a write is held, with 403 `operation_refused`, not 5xx;
   - an expired token is refused;
   - an emergency revocation refuses inside the window.
6. Only then consider moving `ORDINARY_SUSPENSION_WINDOW_RELEASE`. It is a code change, reviewed separately, and it
   needs the candidate applied first: the ten-argument entry does not exist before it.
