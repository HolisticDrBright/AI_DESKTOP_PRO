# Claude telehealth lifecycle repair handoff

Do not integrate or deploy `638b145682f8d09f6368fcdfd97687a9868fa0da` yet. Its existing tests and hosted CI pass, but three additional real-SQL checks reproduce gaps in source authority, patient binding and the calendar-correction claim. No AWS resources, provider activation or PHI settings changed during this audit.

## Audited source and evidence

Repository `HolisticDrBright/AI_DESKTOP_PRO`, branch `claude/telehealth-chart-lifecycle-20261010`, exact remote head `638b145682f8d09f6368fcdfd97687a9868fa0da`. CI run `38075515520` completed successfully at that head. It is a separate branch based on the earlier PR87 head; it has not been merged into Codex's newer host/consent repairs.

The isolated audit copy is `C:\Users\Brand\Documents\Codex\2026-08-18\referenced-chatgpt-conversation-this-is-an\work\DESKTOP_CLAUDE_LIFECYCLE_AUDIT_638b145`. Only its database test file was extended. Claude's remote branch and original working copy were not modified.

Local audit results:

- The actual source candidate's 18 assembly tests pass.
- The 94 telehealth handler tests and four inventory-contract tests pass.
- The actual embedded database's original ten tests pass. Three added Codex diagnostic tests fail: 10 passed, 3 failed, no skips.
- No full browser battery, full suite, live provider, AWS, device or deployment acceptance is claimed by this audit.

## A1 Verify source admission at the chart write boundary

Priority P1. In `infra/aws-clinical-core/production-candidates/telehealth-chart-lifecycle.sql`, `transfer_telehealth_note` checks only the syntax of a caller-supplied digest and revision before accepting caller-supplied content, payload and provenance. The general authenticated chart RPC can be called without the telehealth Lambda's admission. The browser adapter's normal admit-first sequence cannot secure a directly callable RPC.

The diagnostic test invokes the real function under `clinical_core_api` with a valid workforce context and completed calendar appointment, but no telehealth visit or admission exists. It supplies revision 99, a fabricated digest, a payload claiming another practitioner's signature, and fabricated visit provenance. The function returns `created:true` and writes a draft and transfer ledger. This is not an overwrite of a signed chart note, but it defeats the promised signed-source provenance and admission requirement.

Repair with an independently verifiable server admission at the actual SQL write boundary. Bind the organization, patient, appointment, practitioner, intent, signed source revision, source digest, exact content/payload/provenance and the source custody/version. A general API caller must not be able to create or substitute that admission. Recheck current clinical authority and admission revocation/expiry as applicable; allow a retry only for the exact admitted source and destination receipt. A computed digest of arbitrary caller content is insufficient. Do not put service credentials or a signing key in the browser, or trust a caller's `signedAt`/`signedBy` fields.

Add direct-RPC negatives for missing admission, substituted text with the same digest claim, substituted signer/provenance, another clinic/patient/appointment, stale or withdrawn authority and reused intent. Exercise the actual authenticated desktop dispatch as well as SQL. Preserve cross-store reconciliation; do not claim that DynamoDB admission plus a chart transaction is atomic.

## A2 Bind receipt reads to the requested patient

Priority P1. `get_telehealth_record_authority` validates `_patient_id`, then selects the transfer by organization and appointment only. Its transfer lookup omits `patient_record_id=_patient_id`. Calling it for a different active patient in the same clinic returns the original patient's transfer ID, note and encounter IDs, source digest, signer metadata and note state while labeling the response with the unrelated patient.

Filter the transfer and any note/destination data by the independently authorized original patient as well as organization and appointment. No mismatched receipt may be adopted or displayed. Add a same-clinic two-patient test; the existing foreign-clinic patient test does not cover this. Continue to permit authorized reads of the original retained record after supported calendar changes without granting authority to its new calendar patient.

## A3 Make calendar correction claims match the actual constraints

Priority P2. The existing database test calls the calendar patient update with `.catch(() => undefined)`, then treats the journey as a successful correction. Removing that swallowed error proves the update fails on the existing encounter-to-appointment patient foreign key; the new transfer ledger also binds that mutable tuple. The original test never proves a re-patiented calendar row existed.

Do not simply remove historical chart-patient integrity constraints to make the test green. Decide the supported correction model explicitly. If appointments with clinical records retain their original patient identity, assert the refusal and test a corrected successor appointment or the approved amendment path while preserving the original record. If a governed reassociation is intended, implement and test it with immutable original identity, authoritative successor/lineage, isolation and audit—not an unreviewed raw update. Remove the swallowed error and narrow the documentation to the behavior actually proven.

The A3 diagnostic test currently expects the behavior promised by the handoff and therefore fails. An explicit correction contract may legitimately replace that expectation; explain the chosen contract and add its actual successful and negative journeys. A1 and A2 must remain rejection/isolation tests, not be weakened.

## Minimal diagnostic additions

The following were added inside the existing `retained-record read authority for completed visits` describe block. All helpers are from Claude's original test. Run `npx vitest run src/server/clinical-core/telehealth-chart-lifecycle.database.test.ts --no-file-parallelism` against the actual candidate.

```ts
it('Codex A1 refuses forged source/signature claims with no admitted signed visit', async () => {
  await expect(call('select clinical_core.transfer_telehealth_note($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb) as result',[
    org,randomUUID(),appointment,patient,99,sha('unverified source claim'),
    JSON.stringify({text:'FABRICATED signed telehealth source'}),
    JSON.stringify({signedAt:'2026-10-10T00:00:00Z',signedBy:colleague,aiOriginal:'Fabricated provider summary'}),
    JSON.stringify([{sectionKey:'text',refType:'telehealth_visit',refId:appointment,label:'Fabricated signed source'}]),
  ])).rejects.toThrow();
});
it('Codex A2 never returns another same-clinic patient transfer receipt', async () => {
  await transfer(); const unrelated=randomUUID();
  await pg.query("insert into clinical_core.patient_records(id,organization_id,patient_key,first_name,last_name) values($1,$2,$3,'FICTIONAL','OTHER')",[unrelated,org,'patient_'+unrelated.replaceAll('-','')]);
  const response=await authority({patientId:unrelated});
  expect(response.transfer).toBeNull();
});
it('Codex A3 permits actual calendar patient correction without losing the original record receipt', async () => {
  const receipt=await transfer(); const unrelated=randomUUID();
  await pg.query("insert into clinical_core.patient_records(id,organization_id,patient_key,first_name,last_name) values($1,$2,$3,'FICTIONAL','OTHER')",[unrelated,org,'patient_'+unrelated.replaceAll('-','')]);
  await pg.query('update clinical_core.appointments set patient_record_id=$2 where id=$1',[appointment,unrelated]);
  const response=await authority();
  expect(response.appointment?.patient_matches).toBe(false);
  expect(response.transfer?.note_id).toBe(receipt.note_id);
});
```

## Release and integration boundaries

Position 113 and `20261010110000` remain proposed, not registered. Keep the original 112 parent exact. Repairs need a distinct candidate identity with updated SQL pins and validators; do not widen historical registrars by count or alter the frozen 107-to-112 upgrade files. Codex's clinic-specific host registry remains an independent unreleased source candidate, not a competing registered migration113.

Do not merge away Codex's consent, assigned-host, request-local secret and provider-observation repairs. After repair, return full commit, changed contracts, real SQL and dispatch test results, exact candidate identity and recovery semantics. Codex can then coordinate integration, preserving upgrades and hosted acceptance. Clinic export integration, reviewed retention/disposition, Zoom copies, provider coverage, two-participant acceptance and physical device journeys remain open; an inventory alone does not complete those controls.
