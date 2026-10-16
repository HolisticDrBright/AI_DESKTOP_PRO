# Fullscript OAuth installation admission — source candidate

This change is source-only and remains **inactive**. It does not deploy a table, the database guard, the membership-change writer, provider credentials, or a production Fullscript release. It does not make the Desktop or V2 commercial- or PHI-ready.

## Defect reproduced at the parent

At Desktop `ed253b387f3b2ef21d44005bc3d85e57e0e644fb`, the OAuth callback read current membership, exchanged an authorization code, then saved the provider token with an unconditional DynamoDB `PutItem`. A fictional test removed membership during the provider exchange. Fifteen neighboring tests passed; the new test failed because the callback still redirected `connected` and saved the token. A second test showed that another account with the same email could complete the starter's callback because the signed OAuth state had no Cognito subject.

## Conditional repair

- Signed state version 2 binds the starter's Cognito `sub`, actor key, clinic, nonce and expiry. Version 1 state is refused; a person must restart the OAuth flow after deployment.
- Callback observes the subject and clinic `membership-fence/1` versions before its final current-membership read. It consumes the nonce and exchanges the provider code only after these checks.
- The token write is a single DynamoDB transaction: two `ConditionCheck` items prove both fences remain settled at the observed versions, and the token `Put` is conditional on the absence of the old row or its exact prior payload. A concurrent disconnect or reconnect therefore cannot be overwritten by an older callback. If the install fails after the provider issued a token, provider revocation is attempted without logging the token; provider-side reconciliation remains necessary if that attempt fails.
- OAuth start refuses if the fence table is unconfigured. The hosting template adds a fence-table parameter and narrowly scoped `GetItem`/`ConditionCheckItem` permission. It does not create the table or install the clinical guard/writer.

The safety invariant only holds if **every authority-reducing workforce or clinic change begins the same membership fence before its database commit** and a database guard refuses unfenced changes. These components are BLOCKED/unregistered and not deployed together today. A table name alone is not release evidence. Do not enable Fullscript until the guard, all writers, the table and IAM are reviewed and hosted race-tested as one release. Existing connected-token reads, refreshes and provider actions are separate paths and are not certified by this candidate.

## Source verification and open evidence

Fictional tests cover successful installation, removal/suspension before the callback, authority changing during the provider exchange, a different account with the same email, a changing or missing fence, a disconnect and a competing reconnect. The focused Fullscript suite, TypeScript check, lint, clinical build, bundle scan and CloudFormation lint were run locally. A broad unit run reached 9,968 passes, 89 skips, and one inventory-builder suite failure because the source was edited while that builder's exact-source snapshot was running; the isolated inventory suite then passed 78/78 on stable source. Do not cite that broad run as a full pass. Exact-final-head CI and hosted DynamoDB/provider tests are not yet observed at this document's creation.

For hosted qualification, use fictional accounts and an approved reviewed target. Test both race orders on real DynamoDB transactions and the actual clinical membership writer: a subject removed during exchange, a clinic suspended during exchange, a change waiting on the database lock, a callback racing disconnect/reconnect, and an IAM denial of one condition check. Observe no token row, no `connected` receipt, and provider-token revocation or a reconciliation item. Test the authorized path too. Do not use real patient records.
