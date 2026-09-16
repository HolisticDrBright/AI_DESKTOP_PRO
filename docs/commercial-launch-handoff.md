# ALP commercial launch: owner actions and remaining engineering

## Current checkpoint — September 15 synthetic generation acceptance

Subsequent source candidate: [independent production voice](production-owned-voice-candidate.md),
Desktop4a0080f / V248ba65a. Default blocked, not deployed;72rollback-only database
assertions and separate module tests passed. Manifest now includes privacy export
and voice consent (51source migrations). No physical/provider/payment acceptance
or commercial-phase closure is claimed.

The lab backend is now **883623f3dcc837eaf8d54c7bc779777d4ce3e574**.
Saved-measurement generation and actual fictional image extraction/generation
passed **46 distinct hosted checks** after repairing silent omission of noncatalog
line measurements (ALT exposed the defect). Runtime hashes and unchanged synthetic
gates were checked. See [exact deployment and acceptance evidence](synthetic-recovery-hosted-evidence-2026-09-15.md).
Desktop web still runs 4ffd5f2; no installed V2 update or paid mobile build occurred.

The fixed six-phase scope/status lives in V2
`expo/docs/commercial-six-phase-ledger.md`. All six remain partial/incomplete.
Production-owned processing, authoritative plan continuity, full privacy/guardian
fulfillment, clinical activation, provider qualification and physical release
acceptance are not completed by these synthetic checks.

**Historical checkpoints below are point-in-time records.** Their “latest” and
“not deployed” wording must not override a later exact-source checkpoint. Source
implementation, deployed backend, installed app and human approvals are separate.

Latest September 15 source increment: [cross-device lab recovery](cross-device-lab-recovery.md).
New indexed requests support explicit V2 inventory/selection under 26 lab routes;
backend-first deployment, legacy migration and physical acceptance remain.

September 15 scope reconciliation: V2 `expo/docs/commercial-six-phase-ledger.md`
keeps the original six phases fixed; individual source repairs do not complete a
phase. Paired intake contracts now allow genuinely unasked observations to be
absent. [Deletion state claim](lab-deletion-state-claim.md) repairs an upload-vs-
purge race; it does not fulfill account deletion or guarantee erasure against
outstanding upload URLs. These source repairs are not deployed.

Latest September 15 source increment: [release unavailable lab requests](lab-request-retirement.md).
Adds race-safe retirement with 22 authenticated routes and explicit V2 confirmation;
active jobs and saved results remain protected. Also repairs a fixed-port CI collision.
Not deployed, not a paid mobile build, and not commercial or PHI activation.

Latest September 15 source increment: [pre-create lab request recovery](lab-request-creation-recovery.md).
Atomic request/job persistence and scoped discovery now pair with V2's pre-POST
checkpoint. Twenty authenticated lab routes require a coordinated backend-first
deployment. This is source-only progress, not a public launch or PHI activation.

Updated September 14, 2026. Status: **not ready for public launch or real health data**.
This document separates live evidence from code that exists and work still required.
Latest increment: [adult registration and recoverable lab requests](registration-lab-recovery-phase.md).
Adult 18+ self-service with separately verified guardian pediatric access is now the owner's confirmed launch policy.
The new signup check, account-scoped pending-job repair and source-date repair are source-only;
guardian verification and the remaining production engineering below are not completed.
Latest source increment: [population-aware ranges and catalog-release reconciliation](population-range-catalog-release.md). Precise range matching, unsigned source-bound preparation and exact catalog serving-size reconciliation are implemented and locally tested; this does not complete production data capture, clinical release activation or commercial readiness.
It does not sign agreements or approve clinical policy on anyone's behalf.

Latest source phase: [reviewed educational knowledge integration](reviewed-knowledge-engineering.md).
Signed, source-bound educational references can now flow through personal chat
context and lab synthesis, with generation-side revalidation. Default OFF, no real
clinical content signed, no deployment or PHI activation. This is not a new
supplement recommendation or dosing/range rule engine.

Latest source increment: [Core plan context and worker leases](core-plan-context-and-worker-leases.md).
Core is independent AI guidance without per-patient clinician approval; the separate
paid practitioner service requires actual review to label a protocol approved.
Its upgrade price is unspecified. The OpenAI Ironclad signature link is being
re-requested: approval to sign is not an executed BAA. The new consented plan
context and concurrency repair are source-only, not deployed or phone-verified.

Security follow-up: [September 8 dependency repair](dependency-security-2026-09-08.md)
patches critical Desktop framework/image dependencies in source. Rebuild and
deployment are still required; existing running images are not claimed repaired.
V2 has a build-parser mitigation and remaining lower-severity dependency review.

September 8 follow-up: [Production identity repair](production-identity-repair.md) records the repaired registration/bootstrap/session path, disabled AWS deployment and physical Aurora rollback evidence. Production lab/voice conversion and standalone Core data scope remain engineering work.

Latest September 8 follow-up: [Personal consumer API and V2 integration](personal-consumer-api-readiness.md) records the new independently owned API, V2 consent/storage routing, partial personal AI context and 35 rollback-only Aurora assertions. The 48-migration source candidate is **not persistently applied or publicly activated**; persistent Aurora remains at 46. V2 changes are source-only; no paid mobile build was made. [Durable voice](durable-voice-and-owned-storage.md) retains the earlier hosted synthetic voice evidence. These results do not complete commercial readiness.

## Engineering completed in this release

- Added `scripts/refresh-production-candidates.mjs`. It resolves published main in both repositories, builds immutable images, checks the same-container refusal response and ECR Critical/High findings, then updates existing private ECS services without removing them first. Source/image are the only stack parameters changed. Existing identity settings, network boundaries, and PHI controls are preserved. A failed build cannot push its image. The default command is a read-only plan; `--execute` performs the refresh.
- Refreshed production Desktop readiness from `cd6e704` to `d5efca2` and V2 patient-API readiness from `025cb368` to `b6d6160`. Both images scanned with zero Critical/High findings and their exact digests were verified on healthy ECS tasks. These are private readiness services: normal application traffic remains refused.
- Updated the production clinical API and patient-sync worker/callback to Desktop `d5efca2`. Verified PHI false, activation blocked, absent data-plane IAM, disabled sync schedule, and bounded refusal responses. No public clinical data access was enabled.
- Found and repaired an actual Aurora deployment failure: the transformed synthetic family migration created the same tables as the dedicated production family migration. Excluded the redundant synthetic chat/family/workforce-directory variants from production assembly. Removed a stray patch marker from the previously unapplied production caregiver migration. Existing applied SQL hashes were preserved.
- Applied five missing production overlays successfully. Aurora now has 46 migrations, 114 clinical/audit tables, 81 counted contracts and zero retained clinical rows. Normalized migration release SHA-256: `3c7952cad75ae60bf7eba1977e595d45ec48332ac545ae917c43a6c231917bec`.
- Executed the production database rollback acceptance: patient creation/linking, consent, lab import, duplicate prevention, provenance, outbound worker delivery, callback replay refusal, tenant denial, catalog/protocol review and workforce invitation claim passed. It produced 52 audit events inside the transaction and rolled back all fixtures. Evidence SHA-256: `bcdd4b6dcadaca3bee6ae8fe982f65fb5fa341cbf782acdc1338af1b7447de12`.
- V2 source now refuses unapproved Sentry initialization/reporting in production, even if a DSN is present. The old field scrubber did not guarantee that free-text exceptions were free of health information. This change requires a later mobile release; no new TestFlight build was requested or submitted in this phase.

The 226-operation inventory means 226 implemented server operations, **not 226 activated operations**, nor 138 separate missing external integrations. Production still enables zero operations. A database rollback test is not an on-phone acceptance test.

## Decisions and accounts Brandon must supply

| Item | What to do | Completion evidence |
| --- | --- | --- |
| Launch scope | Choose the initial regions, minimum age, consumer features, practitioner services and who can enroll. Current production policy is a narrow supervised lab/intake pilot. A full commercial launch needs a broader reviewed policy and engineering work. | Written scope and intended-use/claims review |
| Pricing | Core **$19.99/month** approved; future Peptide **+$10/month** and Longevity **+$50/month** approved. Initial launch is Core only. No trial was added. Still confirm visit prices, duration, cancellation/no-show and refund policies. | Approved store products plus remaining service policies |
| Payment accounts | Complete the payment provider's business/bank verification and App Store/Play paid-app, tax and banking agreements. Choose store subscriptions for digital features and an appropriate processor for professional services. | Account approval and approved product IDs, supplied through secure configuration |
| Production email | Reply/reapply in the production AWS account Support Center for SES production access. Describe transactional sign-up/reset/invitation email, recipient consent, frequency, bounce/complaint handling and samples. Confirm deliverability notifications. Live September 8 check still reports sandbox, 200/day, 1/sec. | `ProductionAccessEnabled=true` plus inbox delivery tests |
| Business identity and recovery | Confirm the legal company name, public support/privacy contacts, domain control, production root recovery mailbox and MFA/recovery ownership. `info+aws-prod` must not be treated as a separate mailbox without a verified delivery/recovery test. | Owned accounts, delivery evidence, sealed recovery procedure |
| Practitioners | Identify the initial clinic, workforce users, roles and administrator. Approve patient invitation and caregiver consent copy. | Role matrix, professional credentials and clinic onboarding record |
| Clinical content | Review functional-range provenance/population/units, product identity/labels, interaction exclusions, high/low rules, AI red-flag language, cycle/TCM evidence and higher-dose handling. Resolve the remaining conflicting-label/identity packets. | Attributable versioned decisions, not blanket approval inferred from a chat |
| Physical devices | Run the provided five synthetic personas on iPhone, then Android Health Connect. Test partial health data, denied/revoked permissions, two devices, lab regeneration, chat keyboard/context, data transfer, family access and reconnection. | Completed test record, build number, expected/actual outcomes and defect list |

Do not paste passwords or API secrets into chat. Existing secrets must be inspected by name and environment and reused only where their provider/account authorization applies. A sandbox key is not a production key.

## Agreements: what is needed and where

Have qualified privacy/regulatory counsel establish ALP's roles for both direct-to-consumer users and practitioner-connected users. HIPAA can apply to the latter while FTC/state health-privacy obligations can apply to the consumer product. A general "HIPAA compliant" label does not settle either role.

| Organization | Required action before the relevant data flow |
| --- | --- |
| AWS | Archive the active Organizations BAA and confirm account `173535830222` is covered. Review the exact enabled services and configuration against AWS's current eligibility list. The recorded AWS BAA is a completed prerequisite, subject to scope verification; do not request another one unnecessarily. |
| OpenAI | Obtain an executed **API** BAA for ALP's legal entity and the exact production organization. Verify that the organization has the required Modified Retention configuration and the used endpoints/models are covered. Record retention, subprocessors, deletion and incident terms. A personal ChatGPT subscription and `store:false` alone are not evidence of this. Request channel: `baa@openai.com`. |
| Anthropic | Required only if Claude receives patient information or serves as a fallback. Obtain its executed agreement and approved API account/retention configuration before enabling that route. Otherwise keep the route disabled. |
| Zoom | Request the healthcare/HIPAA offering and BAA through Zoom sales/account support for the specific account. A paid Zoom subscription alone does not establish coverage. Decide whether recording/transcription will be off; review additional storage/subprocessors if on. Configure provider-owned Server-to-Server OAuth securely. |
| Fullscript / laboratory partners | Obtain production Integrate access and the appropriate agreement for each party's role, including a BAA where applicable. Confirm authorized practitioner accounts, permitted product/lab APIs, OAuth, order/result handling and privacy terms. Do not assume sandbox login equals production access. |
| Clinics using Desktop | Arrange ALP's customer agreement and BAA when ALP operates as a clinic's business associate; document permitted use, support access, export, termination and deletion. |
| Messaging, support and observability | If a selected vendor will receive PHI, obtain the appropriate BAA and approved service configuration first. Otherwise enforce exclusion of health content, identifiers, recordings and screenshots. Sentry production reporting is disabled in the new source pending this decision. |
| Google Workspace/calendar | Review the specific eligible Workspace services/BAA if PHI will enter Google. A personal Gmail account or OAuth consent alone is insufficient evidence. Minimize external calendar event details and keep clinical notes in ALP. |
| Payment processor | Review the payment-processing role with counsel. Do not assume every payment provider needs or offers a BAA. Keep diagnoses, labs, symptoms, protocols and patient chart IDs out of descriptors, metadata and receipts; use opaque billing references and tokenized cards. |

Junction was removed from the selected wearable design. Do not buy or reactivate it for launch. Direct HealthKit/Health Connect still requires permission, store disclosures and testing. Passio, alternate AI, SMS and other optional vendors can remain unavailable until chosen and approved.

## Remaining engineering (not completed by obtaining contracts)

Latest source increment (September 16, branch `claude/gracious-hypatia-jbd3br`, head
`a9df3f1f84ddb49168bc84e41070c67cfbf51dcb`): production-owned lab/document candidate
and device-bound delivery claims (`f04dfa4`, `c7cc4a1`), authoritative active-plan
pointer (`8f2b635`), privacy request ledger with legal holds, retention gate and
guardian authority (`771f54c`), owner collection context on lab observations with
reproductive-consent enforcement plus range activation readiness tooling (`fc59202`),
provider configuration gate and workforce payment reconciliation (`454e3f5`), and
security/load/application-rollback qualification harnesses (`a9df3f1`). Each is
documented in `docs/` (owned-lab, lab-delivery-claim, owned-active-plan,
owned-privacy-requests, owned-lab-collection-context, lab-range-activation-readiness,
provider-failure-reconciliation, release-qualification-harnesses). None is deployed;
no hosted, Aurora or device evidence; PHI stays disabled. The authoritative six-phase
ledger lives in V2 `expo/docs/commercial-six-phase-ledger.md`.

Previous source increment: [independent personal lab history](personal-lab-history-readiness.md).
Lab-specific storage/AI consent, owner-only observation history, duplicate protection,
production cache isolation and protection against client context overrides are
implemented and rollback-tested. No production document analysis/verified ranges
or installed mobile release is implied. Source migration count is 49; persistent
Aurora stays at 46. The remaining list below still requires engineering work.

1. **Functional production hosting and bootstrap.** Deploy the functional production services, controlled ingress/TLS/domains/rate limiting, real organization/identity bootstrap and approved migrations/configuration. The refreshed readiness containers intentionally expose only health checks. Production self-service identity creation and independent consumer operation need a physical acceptance pass; the current narrow pilot is not the full consumer launch.
2. **Expanded production feature contracts.** Reconcile V2 and Desktop's scope gates and deploy separately approved lab analysis, catalog, Ask ALP, transcription, daily guidance, reproductive-health, telehealth and family routes required by the chosen commercial scope. Several current features run on synthetic services and cannot be made live by removing the banner. Retire synthetic Fly routing from the commercial release.
3. **Consumer subscription activation and acceptance.** Core-only mobile purchasing/restore, server-verified Apple/Google subscriptions, durable AWS ownership/entitlements, replay/refund handling and paywalls are now implemented in V2. Its `expo/docs/core-launch-engineering.md` records the disabled Sandbox deployment and successful physical DynamoDB isolation/replay tests. Store products/credentials, matched test identity configuration, concurrency/alerts and actual store/device acceptance are still required. Desktop-owned production Ask ALP/daily-guidance now have Core entitlement guards in source, not yet deployed. The legacy add-on enrollment constant remains false intentionally; it does not control Core billing.
4. **External provider activation and verification.** Finish Zoom and calendar connections, Fullscript production mappings/offers, transactional email/reminders, and payment/webhook delivery using the selected production accounts. Prove booking conflict/hold/charge/refund/cancel flows with provider test credentials before real charges.
5. **Privacy request fulfillment.** Verify that export/correction/deletion requests are processed to completion across AWS records, objects, transcripts, identities and applicable backups/retention. A screen that queues a deletion request is not proof that deletion happened. Define responsibility and the response SLA.
6. **Clinical/regression release.** Confirm every input marker is represented or explicitly excluded with a reason; ranges are sourced and unit/population appropriate; historical dates are trustworthy; high iron and reproductive context exclude unsuitable products; counts and purchase links agree; Ask ALP sees relevant available data and cites only present context. Four to six products is a maximum/ranking goal, not a quota that should override eligibility.
7. **Reliability and security.** Complete production restore/rollback drills, load/abuse testing, external security review, dependency/image scans, owned alerts and incident-response exercise. Existing PITR evidence is useful but does not cover all object/identity/application recovery.
8. **Mobile/store release.** Incorporate the new telemetry fix, execute the physical matrix, prepare store metadata/privacy/Data Safety/Health declarations, verify deletion and purchases, and submit iOS/Android candidates after authorization to spend build credits.

## Documents, policies and operational responsibility

- Formal HIPAA security risk analysis and risk-management plan covering the actual deployed system, including workforce endpoints and devices.
- Privacy policy, consumer terms, applicable clinic Notice of Privacy Practices, explicit health/cycle/AI/sharing consents, retention/deletion policy and subprocessor list.
- FDA/intended-use and health-claims review for automated patient-specific interpretation and treatment/product suggestions. An "educational" disclaimer alone does not determine regulatory status. Review peptide functionality and practitioner licensing/telehealth regions.
- FTC Health Breach Notification Rule and applicable state consumer-health/privacy analysis, including reproductive health and affiliate/marketing disclosures.
- Named privacy/security incident owners, workforce training, least-privilege access reviews, offboarding, emergency access, breach-response contacts and documented exercises.
- Support contact and response SLA, refund/cancellation policy, service downtime communications, cyber/professional insurance review and real on-call alert recipients.
- Legacy shared Supabase data/secret review: rotate exposed credentials, investigate use, and carry out an approved export/retention/purge plan. This is not permission to delete old records automatically.

## Source guidance checked for this handoff

- [HHS Security Rule](https://www.hhs.gov/hipaa/for-professionals/security/laws-regulations/index.html)
- [OpenAI API BAA](https://help.openai.com/en/articles/8660679) and [eligible functionality / Modified Retention](https://help.openai.com/en/articles/20001069-hipaa-eligible-products-and-functionality)
- [AWS SES production access](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html)
- [Apple review guidelines](https://developer.apple.com/app-store/review/guidelines/) and [account deletion](https://developer.apple.com/support/offering-account-deletion-in-your-app/)
- [Google Play health content](https://support.google.com/googleplay/android-developer/answer/16679511) and [account deletion](https://support.google.com/googleplay/android-developer/answer/13327111)
- [FTC health breach requirements](https://www.ftc.gov/business-guidance/resources/complying-ftcs-health-breach-notification-rule-0)
- [FDA clinical decision support guidance, January 2026](https://www.fda.gov/regulatory-information/search-fda-guidance-documents/clinical-decision-support-software)

## Acceptance standard

Commercial readiness is reached only when the selected release's code, deployed source/digests, identities, provider settings, signed agreements and physical results agree. Record excluded launch features explicitly. Do not infer approval from an installed credential, green unit tests, a synthetic demo or a healthy readiness container.
