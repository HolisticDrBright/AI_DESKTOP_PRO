# Saved-plan reviewed context contract

The saved-plan API accepts optional sourceContextSha256 only when it matches the
normalized patientContext under canonical JSON plan-context/1 (recursive ASCII
key order; array order retained). The digest is stored with the owned job and
preserved in owner-scoped inventory/recovery. It is not a clinical signature,
deidentification claim or permission to activate restored cloud plan copies.

The matching V2 implementation requires explicit raw-input review before saved-lab
regeneration and checks input drift before replacing the current plan. Restart
recovery also checks the saved digest; changed context can only be archived inertly.
Legacy jobs without a digest are not retroactively certified. Complaint severity
zero is valid; non-finite lifestyle inputs and unknown nested fields are refused.

Source evidence: 1,500 unit tests passed /11 existing skips; typecheck and lab
artifact build passed; lint zero errors/four pre-existing warnings. V2 886 passed
/one existing hosted skip. Shared canonical fixture and mocked request/recovery
tests exercise the contract without invoking a model or accessing health data.

Deploy this API before shipping the corresponding mobile request field. This
checkpoint is not deployment/device evidence. Synthetic/PHI configuration, source
verification and clinical activation controls are unchanged. All six commercial
phases retain their recorded partial/incomplete statuses.
