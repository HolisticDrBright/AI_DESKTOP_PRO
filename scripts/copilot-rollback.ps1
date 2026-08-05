<#
.SYNOPSIS
  Phase 10B.2 — emergency rollback for the clinical copilot provider.

.DESCRIPTION
  Stops external AI calls and removes access, WITHOUT deleting audit
  history. Every step is additive or a state change; nothing here issues a
  DELETE against a run, a telemetry row, or an activation history entry.

  WHY NOTHING IS DELETED. The runs, the external-call ledger, and the
  append-only activation history are the record of what happened. An
  incident is exactly when that record matters most, and a rollback that
  tidies it up destroys the evidence for the review that follows. The
  history table refuses UPDATE and DELETE by trigger, so this script could
  not remove it even if it tried.

  ORDER MATTERS. The kill switch goes first because it is the fastest and
  is re-read inside the same transaction that takes a budget slot, so it
  closes the window rather than narrowing it. Everything after it is
  belt-and-braces.

.PARAMETER Reason
  Required, recorded on every state change. An unexplained rollback is an
  unexplained outage tomorrow.

.PARAMETER Region
  AWS region, for the optional step 4.

.PARAMETER KmsKeyId
  The copilot secret CMK. Disabling it revokes decryption account-wide for
  this secret without deleting anything.

.PARAMETER SkipAws
  Do the database steps only.

.EXAMPLE
  ./scripts/copilot-rollback.ps1 -Reason "incident 42 — suspected prompt injection" -SkipAws
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Reason,
  [string]$Region,
  [string]$KmsKeyId,
  [switch]$SkipAws
)

$ErrorActionPreference = 'Stop'
if ($Reason.Trim().Length -lt 3) { throw "A reason of at least 3 characters is required." }

Write-Host ""
Write-Host "Phase 10B.2 — copilot rollback" -ForegroundColor Red
Write-Host "Reason: $Reason"
Write-Host ""
Write-Host "This script PRINTS the steps and the SQL to run under an operator"
Write-Host "session. It deliberately does not hold a database credential of its"
Write-Host "own: a rollback tool with standing write access to the clinical"
Write-Host "database is a larger risk than the incident it exists to contain."
Write-Host ""

$sqlReason = $Reason.Replace("'", "''")

Write-Host "STEP 1 — Kill switch (fastest; blocks new calls immediately)" -ForegroundColor Yellow
Write-Host @"
  select public.set_copilot_kill_switch(
    '<organization_id>'::uuid, '<provider_id>'::uuid, true, '$sqlReason');
"@
Write-Host "  Or: Settings -> Security & Governance -> Provider activation -> Engage kill switch."
Write-Host "  Historical runs are untouched. This only stops new calls."
Write-Host ""

Write-Host "STEP 2 — Narrow the activation scope back to nothing" -ForegroundColor Yellow
Write-Host @"
  select public.set_copilot_activation_scope(
    '<organization_id>'::uuid, '<provider_id>'::uuid,
    'unset', 'none', null, null, '$sqlReason');
"@
Write-Host "  Recorded as a scope change in the append-only history."
Write-Host ""

Write-Host "STEP 3 — Suspend or revoke the organization activation" -ForegroundColor Yellow
Write-Host @"
  -- reversible:
  select public.set_copilot_activation_state(
    '<organization_id>'::uuid, '<provider_id>'::uuid, 'suspended', '$sqlReason');

  -- terminal, cascades to every organization on this provider:
  select public.revoke_copilot_provider('<provider_id>'::uuid, '$sqlReason');
"@
Write-Host "  Revocation is checked by the gate BEFORE any secret is resolved,"
Write-Host "  so a revoked provider never reaches AWS or the network."
Write-Host ""

Write-Host "STEP 4 — Remove AWS access (optional; the DB steps already stop calls)" -ForegroundColor Yellow
if ($SkipAws) {
  Write-Host "  Skipped by -SkipAws."
}
elseif (-not $Region -or -not $KmsKeyId) {
  Write-Host "  Supply -Region and -KmsKeyId to print the exact commands."
  Write-Host "  Disabling the CMK revokes decryption without deleting the secret,"
  Write-Host "  its versions, or its rotation history."
}
else {
  Write-Host "  Disable the key (reversible, destroys nothing):"
  Write-Host "    aws kms disable-key --key-id $KmsKeyId --region $Region"
  Write-Host ""
  Write-Host "  Re-enable after the incident:"
  Write-Host "    aws kms enable-key --key-id $KmsKeyId --region $Region"
  Write-Host ""
  Write-Host "  Do NOT schedule key deletion. It is irreversible after the window"
  Write-Host "  and would make historical secret versions unrecoverable, which"
  Write-Host "  is not something an incident response should decide under time"
  Write-Host "  pressure."
}
Write-Host ""

Write-Host "STEP 5 — Rotate the OpenAI key" -ForegroundColor Yellow
Write-Host "  Revoke the project key in the OpenAI dashboard, mint a new one, then:"
Write-Host "    ./scripts/bootstrap-copilot-secret.ps1 -SecretId <arn> -Region <region>"
Write-Host "  Keep the kill switch engaged until the resolver TTL (5 min) has passed."
Write-Host ""

Write-Host "STEP 6 — Evidence to collect BEFORE releasing the kill switch" -ForegroundColor Yellow
Write-Host @"
  -- what was sent, in safe aggregate (no prompt or response is stored)
  select result_category, count(*), sum(input_tokens), sum(output_tokens),
         sum(estimated_cost_cents), min(reserved_at), max(settled_at)
    from public.clinical_copilot_external_calls
   where organization_id = '<organization_id>'
   group by result_category order by 2 desc;

  -- who changed what, and why (append-only)
  select change_kind, reason, actor_user_id, recorded_at, from_state, to_state
    from public.clinical_copilot_activation_history
   where organization_id = '<organization_id>'
   order by recorded_at desc limit 50;
"@
Write-Host "  Take provider_request_id values to OpenAI support if request or"
Write-Host "  response CONTENT is needed. It is deliberately not stored here."
Write-Host ""

Write-Host "STEP 7 — Release only after the review" -ForegroundColor Yellow
Write-Host @"
  select public.set_copilot_kill_switch(
    '<organization_id>'::uuid, '<provider_id>'::uuid, false, '<review reference>');
"@
Write-Host "  A reason is required in this direction too. Releasing is the more"
Write-Host "  consequential direction and is not the cheaper one to do."
Write-Host ""
Write-Host "Nothing in this checklist deletes a run, a telemetry row, or a history entry." -ForegroundColor Green
