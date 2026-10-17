# Campaign send authority: queued email pauses when a login is revoked

**Status.** This is source only. The campaign engine ships off (`CampaignEngineEnabled=false`), and nothing here was
applied, deployed or sent. The evidence is unit tests on the fictional engine: an in-memory store, a fake SES at its
SDK boundary, and a fictional revocation signal. Fictional practices, logins and addresses only.

**Owner decision, 2026-10-16 (Brandon).** Email a compromised practitioner already queued must pause until a different,
currently authorized staff member reviews it. This document is that decision in source.

## 1. What was wrong

The staff route reads the emergency revocation's signal (`docs/campaign-staff-revocation-2026-10-17.md`), so a revoked
login could no longer *edit* campaigns. But the sending job never read it:

- a broadcast the login had scheduled kept going out, page after page;
- a sequence it had started kept sending each step to every new subscriber;
- a step SES refused was retried under the same authority.

The records could not have been checked anyway. A broadcast held no actor at all, a sequence held no actor, and a
template's approval held a person and a name, while the signal is keyed by the login's subject (the ID token's `sub`).
A person can hold several logins over time; revocation names one.

**Failing before.** The 20 behavioural tests in `src/campaigns/send-authority.test.ts` were written first and all 20
failed against the unchanged engine. The core cases failed because email was sent: `expected [ … ] to have a length of
+0 but got 1` for a revoked sequence, a revoked broadcast, a retry, an outage and a missing signal.

## 2. The rule (send-authority/1)

A queued send rests on these logins:

- everyone who scheduled, started or edited it since its last review (`authorizedBy`);
- the login that approved each of its emails (`approval.by.subject`).

The job re-reads every one of them from the signal. Nothing is cached between checks. It checks:

1. before a broadcast moves from `scheduled` to `sending`;
2. at the start of each page of 100 contacts;
3. for every email, after its create-only claim is written and immediately before SES is called.

| What the check finds | What happens |
| --- | --- |
| Every login readable and not revoked | The email goes to SES |
| One of the record's logins revoked | Held: `hold = authority_revoked`, naming the people (never the subjects). Recorded on the record. |
| An approving login revoked | Held: `approval_revoked` |
| The record names no login (made before this change) | Held: `authority_unrecorded`. Never assumed. |
| An email approved before approvals recorded a login | Held: `approval_unattributed` |
| The signal unreadable | Nothing is sent this pass and nothing is recorded. Retried 15 minutes later. |
| The sender has no signal configured | No practice sends at all. The pass reports `staff_revocation_unconfigured`. |

When a check holds an email after its claim, the claim is deleted and the month's count is given back. The email is
neither sent nor marked as sent, so the review can send it later, exactly once.

**Edits, pauses and restarts by someone else** add that person; they never remove anyone.

- One entry is kept per login, with its latest action.
- Pausing needs no authority, because it sends less.
- Starting a held sequence is refused (`held_for_review`). Starting again is not a review.
- An active sequence that predates this change, edited by anyone, becomes `authority_unrecorded` at once. Otherwise a
  colleague's edit would make an unknown original activator look trusted.

## 3. The review (`resume_held_send`)

A held broadcast or sequence resumes only through an explicit review. All of these must hold:

1. **The reviewer holds a marketing role.** That is the same role that could have scheduled the send.
2. **The reviewer is not a person the hold names.** This refuses the revoked person's *replacement* login too, because
   a new subject for the same person is still that person (`independent_reviewer_required`). The revoked login itself
   is refused earlier, at the staff route (403).
3. **The reviewer's own login is read again and is not revoked.** An outage is 503 `staff_revocation_unavailable`, and
   nothing changes.
4. **Every approved email it would send rests on a recorded, unrevoked approving login.** Otherwise the review is
   refused with `template_reapproval_required`, and someone approves the email again. Re-approving the same version is
   allowed, and it records the approver's login.

Then the record's authority becomes the reviewer alone (`reviewed`) and the hold is cleared. In the same all-or-nothing
write, a create-only audit item is written: `send-review/1` with the target, the reviewer's person and login, the
previous hold, and the people whose authority it replaced. A review sent again after a lost reply is recognised and
recorded once.

**The screen** shows each held send's reason and a *Review and resume* button. A held sequence offers no *Start*. The
overview never carries a login subject: who acted and when, by person, and nothing else.

## 4. What it preserves

Each of these has a test in `send-authority.test.ts`:

- **Unsubscribe** works while a send is held, and the review sends nothing to someone who left.
- **Never twice.** An email SES gave no answer to keeps its claim and is never sent again, before or after review.
- **The monthly allowance.** A held email's count is given back.
- **Quiet hours** still apply after a review.
- **Tenant isolation.** Revoking one practice's admin leaves another practice's sends untouched.

The existing sending, sign-up, separation, status and events suites pass unchanged, apart from each fictional staff
identity now carrying a login subject.

## 5. The race that remains, stated

**An email already handed to SES when the revocation lands is not recalled.** The last check runs after the claim,
then SES is called; between them there is only rendering the email.

- Sends are sequential and paced, so at most one email per practice per pass can be in flight past its check.
- The test *"the remaining race, stated"* revokes inside the SES call: that email goes out, and the next one is held.

The other gap, between the clinical database committing a revocation and the signal being published, is a separate
question. See `docs/revocation-signal-timing-2026-10-17.md`.

## 6. Infrastructure (template, not applied)

- `CampaignSenderFunction` gets `CAMPAIGN_STAFF_REVOCATION_TABLE`.
- `CampaignSenderRole` gets the same single statement the API role has: `dynamodb:GetItem` on
  `CampaignStaffRevocationTable`, and nothing else.
- The SES events function and role still never name the table.

`staff-revocation.test.ts` and `outreach-separation.test.ts` pin exactly these two readers, with `GetItem` only.

## 7. Evidence

| Suite | Result |
| --- | --- |
| `src/campaigns/send-authority.test.ts` (new) | 22/22. Failing before: the first 20, all 20 failing on the unchanged engine. |
| Campaign, outreach, status and screen suites (19 files) | All pass |
| `CampaignsView.render.test.ts` (+1) | A held send's reason and review button; no *Start* on a held sequence |

## 8. Held, explicit

1. **The SES-acceptance race** in §5. It cannot be closed from this side of SES.
2. **Twenty logins.** A record holds at most twenty distinct logins between reviews. The 21st edit is refused
   (`review_required_before_more_edits`), and a review resets the list. A practice with that many marketing staff on
   one sequence is unlikely; the refusal is explicit, never a silent drop.
3. **A legacy draft broadcast** is trusted from the login that schedules it. Its earlier editors are unknown, but
   scheduling requires a test send to the scheduler and an approved email.
4. **The review re-reads the signal once per login.** There is no batch read; the cost is a few reads per review.

## 9. Codex hand-back (ordered, not run)

1. In a fictional qualification account, apply the campaign template. Confirm the sender role's single `GetItem` on
   the signal table and the sender's `CAMPAIGN_STAFF_REVOCATION_TABLE`.
2. Remove that variable and confirm the next pass reports `staff_revocation_unconfigured` and sends nothing.
3. With fictional practices:
   - schedule a broadcast and start a sequence;
   - write a signal item for the scheduling login;
   - confirm the next pass sends nothing and the Campaigns screen shows the hold;
   - review it as a second fictional staff login and confirm sending resumes;
   - confirm the audit item exists.
4. Make the signal table unreadable. Confirm a pass sends nothing and records no hold.
