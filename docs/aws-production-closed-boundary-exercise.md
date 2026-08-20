# AWS production closed-boundary exercise

This is a repeatable technical exercise for the production account while PHI
is disabled. It does not authorize PHI, certify HIPAA compliance, or substitute
for the named incident-response exercise that remains open.

The guarded script verifies all of the following without creating a clinical
record:

- caller is account `173535830222` and the foundation reports
  `production-clinical`, `clinical_phi_target`, and `PhiAllowed=false`;
- the candidate stack reports an exact 40-character source commit,
  `ActivationState=blocked`, and `DataPlaneEnabled=false`;
- both Cognito pools expose the immutable four-character
  `custom:production_bound` attribute required by the production API, without
  creating or approving an identity;
- all six template-managed GuardDuty protection plans are enabled, and stack
  drift is either clean or limited exactly to GuardDuty's service-returned
  disabled `AI_ANALYST`, `AI_PROTECTION`, and mutually exclusive
  `EKS_RUNTIME_MONITORING` result fields; any other drift fails the exercise;
- API Gateway exposes exactly 21 explicit clinical routes, every route requires
  the correct JWT authorizer, and no wildcard clinical route remains;
- an unauthenticated clinical request returns 401;
- the deployed disabled Lambda returns the bounded 503
  `production_not_activated` contract;
- the Lambda execution role has no managed policies and its only actions are
  encrypted-log stream creation and event writes;
- Aurora contains nine reviewed migrations, 17 application tables, and zero
  organization, person, patient, lab-import, clinical-record, or audit rows;
- the disabled-function error alarm is `OK`; and
- the last 15 minutes of disabled-function logs contain no credential or
  clinical-content markers.

Run from a controlled engineering workstation:

```powershell
./scripts/run-aws-production-closed-boundary-exercise.ps1 -ConfirmPhiDisabled
```

An explicit `-OutputPath` may be provided when the parent evidence directory
already exists. The script produces a canonical SHA-256 so an approved evidence
repository can retain the result without placing runtime evidence in source.
The evidence also records the deployed source commit and Lambda code digest.

This exercise is intentionally bounded. The privacy/security owners must still
run and sign the lost-device, compromised-account, leaked-token, malicious
insider, vendor-outage, integrity-loss, ransomware, breach-notification, and
on-call escalation table-tops. DNS/WAF, controlled production identity
bootstrap, vendor decisions, and the activation manifest remain separate gates.
