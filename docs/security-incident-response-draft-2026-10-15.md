# Security incident response — owner/counsel review draft

**Status:** draft, not approved or exercised. This is an operating procedure for The Holistic Approach LLC and the AI Longevity Pro V2 / Desktop Pro services. It does not authorize real patient data, PHI activation, a production release, or a conclusion that a particular event is a reportable breach. The person or clinic legally responsible for each affected record must be identified before notices are decided. A nationwide practitioner rollout also needs jurisdiction-specific legal review.

## Ownership and contact gap

- Incident commander and primary responder: Brandon Bright, monitored at `info@AILongevityPro.app`.
- Secondary notification route: `BrandonBright@gmail.com`. It reaches the **same person**, not an independent backup. A separately named, trained backup with access to the runbook and an escalation method is required before production PHI use.
- Privacy/legal decision maker: to be named by The Holistic Approach LLC and, for clinic records, the affected clinic. Outside counsel should review notification obligations and the respective covered-entity/business-associate roles.
- Technical operator: an authorized, individually identified operator with scoped AWS/provider access; never a shared or root account for routine response.

## 1. Receive and record

Treat unusual access, failed or unexpected authorization, lost devices, suspected credential exposure, provider alerts, integrity failures, unavailable critical services, and possible disclosures as **suspected incidents**. Open a restricted incident record immediately. Record who received the alert, discovery time and timezone, source, affected environments/accounts, likely data categories, current service state, and a case identifier. Put no patient content, credentials, tokens, or raw health data in ordinary tickets, email subjects, chat, or metrics.

The responder acknowledges the alert through the monitored channel and escalates if unavailable. There is not yet a verified backup person or response-time service level. Test that chain before PHI activation. Distinguish a synthetic qualification alarm from a production event; never infer that a synthetic exercise is production incident evidence.

## 2. Triage and contain

Preserve original logs and configuration/version identifiers before changing a system. Identify whether the event affects confidentiality, integrity, availability, or multiple categories; whether access is continuing; which identities, clinics, objects and providers are in scope; and whether a hold or investigation limits deletion. Record the decision maker and time for each containment action.

Choose the least destructive effective containment: revoke a compromised session/key, disable an affected identity, pause a provider route, narrow network or IAM access, or block a candidate service. For suspected AI-provider scope or retention failure, stop model calls through the governed authority switch while preserving evidence. Do not turn PHI on, copy a synthetic credential into production, delete possible evidence, or modify clinical records to make a test pass. An emergency service shutdown needs a documented continuity and patient-communication decision, not a silent toggle.

Notify the appropriate clinic contact promptly if its records may be affected, under the applicable agreement and designated secure channel. Do not send detailed PHI through the general alarm topic; the SNS topics are notification signals, not incident records.

## 3. Investigate and assess notification duties

Build a scoped evidence timeline from immutable audit rows, deployment/source hashes, cloud access logs, object versions, provider logs and identities. Record collection method, custodian, time and digest; preserve originals. Confirm whether information was actually acquired/viewed, merely exposed, altered, or unavailable. Keep unknowns explicit.

Counsel/privacy leadership must classify the event for each affected legal entity and record type. For an impermissible use or disclosure of unsecured PHI, the HIPAA Breach Notification Rule presumes a breach unless a documented risk assessment shows a low probability of compromise or an exception applies. The assessment considers the nature and extent of PHI, the unauthorized person, whether it was acquired/viewed, and mitigation. Do not substitute “encrypted at rest,” a green test, or a provider's verbal reassurance for the complete assessment. Record the decision and evidence even when notice is not required. [HHS Breach Notification Rule](https://www.hhs.gov/hipaa/for-professionals/breach-notification/index.html).

If the event is a reportable breach, have counsel coordinate affected-individual, HHS and (where applicable) media notices, and any state-law, clinic-contract, vendor or consumer-app duties. HIPAA individual notices are due without unreasonable delay and no later than 60 days after discovery; business associates must notify their covered entity without unreasonable delay and no later than 60 days, and contracts may impose shorter terms. The HHS timing is an outside limit, **not** a planned waiting period; state law or an agreement may be faster. Do not send public or patient notices from an unreviewed template. [HHS Breach Notification Rule](https://www.hhs.gov/hipaa/for-professionals/breach-notification/index.html); [HHS Business Associate guidance](https://www.hhs.gov/hipaa/for-professionals/privacy/guidance/business-associates/index.html).

## 4. Recover, verify and close

Restore from a known-good, approved artifact and backup only after the exposure path is closed. Verify access isolation, data integrity, held-copy handling, affected account resets, provider settings, alarm delivery, and monitoring; test negative as well as positive paths. For data restoration, reconcile object/version and database receipts rather than assuming a job succeeded from its HTTP response. Have an independent reviewer check the recovery evidence before reopening an affected PHI path.

Close only with a written outcome: timeline, root cause, affected scope and uncertainty, containment and recovery receipts, legal classification and notices or reason none were required, remaining risks, follow-up owners, and dates. Track corrective actions to verified completion. Conduct a tabletop and a backup-restore/failed-sweep drill with fictional data before production PHI activation, then repeat at a reviewed cadence. NIST SP 800-61 Rev. 3 frames preparation, detection, response and recovery as an ongoing risk-management process; a written runbook alone is not proof that the process works. [NIST SP 800-61 Rev. 3](https://csrc.nist.gov/pubs/sp/800/61/r3/final).

## Required review before adoption

1. Brandon approves or changes the responder chain and names a **different person** as trained backup; both channels receive a tested production alarm.
2. Counsel maps The Holistic Approach LLC, independent practitioners/clinics, V2 direct consumers and vendors to the appropriate legal roles, agreements and federal/state notice rules. Confirm the exact OpenAI agreement entity and covered project separately.
3. Security lead reviews severity definitions, internal escalation targets, access to evidence, provider contacts, legal holds and whether existing logs/backups can support the procedure.
4. Run a fictional tabletop and restore drill; attach dated, source-bound evidence and unresolved findings. An exercise is not a real breach notification.
5. Only then bind an approved runbook version to the production activation review. Keep `PhiAllowed=false` and `Activation=blocked` until the broader hosted, device, clinical and human gates also pass.

HHS requires procedures to identify and respond to suspected or known security incidents, mitigate known harmful effects where practicable, and document incidents and outcomes; it does not prescribe one universal playbook. [HHS Security Incident Procedures FAQ](https://www.hhs.gov/hipaa/for-professionals/faq/what-does-the-security-rule-require-a-covered-entity-to-do-to-comply/index.html).
