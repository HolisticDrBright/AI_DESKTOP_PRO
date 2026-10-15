# Stopping every model call

The right to send protected information to the model vendor rests on the executed agreement, its coverage of the
actual organization and project, and the separate provisioning act that changes the vendor's default retention.
Any of those can change on a day nobody is deploying. On that day the correct behaviour is that no protected
request leaves at all.

## Where the switch lives

Beside the key it governs, in the vendor secret:

```json
{
  "OPENAI_API_KEY": "sk-…",
  "authority": {
    "record": "model-vendor-authority/1",
    "state": "active",
    "retention": "modified_zero_retention",
    "agreement": "vendor-baa/2026-09-17",
    "effectiveAt": "2026-09-17"
  }
}
```

Every model path in `src/server/clinical-core` obtains its key through `parseOpenAISecretForRequest`, which reads this record and
throws `ModelVendorAuthorityRefusal` unless a call may be sent right now. No path caches the key, so a secret write takes
effect on the very next call — no redeploy, no stack update, no template change. `model-vendor-authority.test.ts` asserts
both halves: the decisions themselves, and that every module posting to the vendor takes its key from that one parser.

The `model-vendor-authority/1` example above remains valid only for PHI-off testing. When `PHI_ALLOWED=true`, the
request path requires `model-vendor-authority/2` with the exact covered OpenAI organization identifier, a reviewed
project identifier, and SHA-256 identifiers for separate agreement-scope and retention-configuration reviews. It
adds `OpenAI-Organization` and `OpenAI-Project` headers to each Responses request. A v1 record cannot enable a PHI
request, even with `modified_zero_retention`. Those hashes are evidence pointers, not proof that the underlying
agreement or configuration has been reviewed; the operator must verify them against the actual organization,
project, retention settings and executed agreement before any activation. The signed amendment's operator-name
discrepancy also remains a human/legal review item. No production PHI activation is authorized by this source change.

`state` is `active`, `suspended` or `terminated`. `retention` is `modified_zero_retention` or `vendor_default`.
`agreement` is a reference to the executed agreement — never its text. `effectiveAt` is the day the state took effect; a
future day is not yet in force.

## What refuses, and why

| Situation | Category | Reason |
| --- | --- | --- |
| `state` is not `active` | `model_vendor_authority_withdrawn` | The right to send ended. Refuses whatever the posture. |
| `effectiveAt` is in the future | `model_vendor_authority_not_in_force` | The record describes a state that has not begun. |
| No `authority` field, `PHI_ALLOWED=true` | `model_vendor_authority_missing` | Protected information would be in the request and nothing records the right to send it. |
| No `authority` field, `PHI_ALLOWED=false` | *permitted* | No protected information can be in the request, so the agreement is not what permits it. |
| `retention` is `vendor_default`, `PHI_ALLOWED=true` | `model_vendor_retention_unconfirmed` | Approval to sign is not an executed agreement, and an executed agreement is not the act that turns retention off. |
| v1 record, wrong organization, or missing reviewed project/scope, `PHI_ALLOWED=true` | `model_vendor_scope_unconfirmed` | The request is not pinned to the reviewed BAA-covered organization and project. |
| Record present but unreadable | `model_vendor_authority_malformed` | An authority record that cannot be read is an authority that does not exist. |

Callers translate the refusal into `provider_unavailable` for the person waiting and write the category to the operator
log. The category is code-shaped, so it is safe to keep for the maximum retention (`docs/` and `log-safe-error.ts`).

## Using the switch

```bash
npm run build:aws-model-vendor-authority-operator

AWS_REGION=us-east-2 \
EXPECTED_AWS_ACCOUNT_ID=<account> \
MODEL_VENDOR_SECRET_ARN=<secret arn> \
node dist/aws-clinical-core/model-vendor-authority-operator/index.cjs inspect
```

`inspect` is read-only and reports the recorded state, retention, agreement and effective day, plus whether a key is
present. It never prints the key; neither does any other command.

Stopping asks for nothing beyond the secret, because a right that has ended must be revocable in one command by whoever
is awake:

```bash
… node dist/aws-clinical-core/model-vendor-authority-operator/index.cjs suspend    # reversible
… node dist/aws-clinical-core/model-vendor-authority-operator/index.cjs terminate  # the agreement ended
```

Both keep the agreement reference the record already carried, so the report still names what ended. The report's
`effect` reads `model_calls_refused_on_next_call`.

Permitting again for PHI-off testing requires stating what changed:

```bash
CONFIRM_MODEL_VENDOR_AGREEMENT_EXECUTED=true \
MODEL_VENDOR_AGREEMENT_REFERENCE=vendor-baa/2026-09-17 \
MODEL_VENDOR_RETENTION_MODE=modified_zero_retention \
… node dist/aws-clinical-core/model-vendor-authority-operator/index.cjs activate
```

`MODEL_VENDOR_EFFECTIVE_AT` may name the day the authority began; it defaults to today. Activation writes nothing unless
all three are present and the retention mode is one of the two named values.

For a PHI-capable v2 record, the separate reviewed inputs are also required:

```text
CONFIRM_MODEL_VENDOR_SCOPE_REVIEWED=true
MODEL_VENDOR_ORGANIZATION_ID=<organization identifier named in executed amendment>
MODEL_VENDOR_PROJECT_ID=<reviewed project identifier>
MODEL_VENDOR_AGREEMENT_REVIEW_SHA256=<digest of the reviewed scope evidence>
MODEL_VENDOR_RETENTION_REVIEW_SHA256=<digest of the reviewed retention evidence>
```

The operator refuses a partial v2 set or an organization other than the identifier in the executed amendment.
`inspect` reports the identifiers and review digests, never the key. A successful source or synthetic test does not
establish that the live OpenAI project has the required retention controls, that the agreement covers the legal
operator and use case, or that data is approved for PHI. Keep PHI disabled until those independent reviews and the
other production activation gates are complete. The OpenAI API's `store:false` request setting alone is not a
zero-data-retention project configuration.

Each command writes a new secret version, so Secrets Manager's version history is the record of when the switch moved.

## What this switch does not cover

- `src/server/copilot` has its own governed approval path (`evaluateOpenAIApproval`), which refuses on a revoked or
  suspended organization activation, a missing agreement reference and a retention mode that is not zero or modified.
  It has no production caller today. If one is added, it must be brought under this switch as well.
- Transcription runs on AWS Transcribe, inside the cloud provider's own agreement, and is stopped by the voice shutdown
  path in `docs/production-voice-shutdown.md`, not by this one.
- Stopping model calls is not deletion. Anything the vendor already holds is addressed by the agreement's own terms and
  by the retention mode that was in force, not by this switch.
