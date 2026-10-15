# AWS organization BAA — live metadata check, October 15, 2026

This is an AWS Artifact metadata observation, **not** a HIPAA compliance
assessment or approval to process PHI. No agreement text, secret, patient data,
or provider payload was retrieved.

Read-only `sts:GetCallerIdentity` under the production profile returned account
`173535830222`. `organizations:DescribeOrganization` from that account returned
organization `o-tjxec39f3j` with management account `449901517958`.
`artifact:ListCustomerAgreements` from the production account returned an
`ACTIVE` **AWS Organizations Business Associate Addendum**, effective
2026-08-18 18:19:25 UTC, for that same organization. The isolated synthetic
member account `588966314750` independently returned the same active
organization agreement. The management-bootstrap principal did not have
`organizations:ListAccounts`, and the production member did not have
`organizations:DescribeAccount`; those denied calls were not treated as
evidence of a different organization.

AWS [documents that an organization agreement covers existing and later
member accounts](https://docs.aws.amazon.com/artifact/latest/ug/managing-agreements.html).
AWS also [limits ePHI processing to HIPAA-eligible services and requires
customer configuration under its shared-responsibility model](https://aws.amazon.com/compliance/hipaa-eligible-services-reference/).
The active BAA metadata therefore removes the *missing AWS agreement* as the
observed immediate blocker for these two accounts, subject to legal review of
the executed terms. It does not establish that the application's exact AWS
services, provider projects, encryption, retention, access, monitoring,
backup/recovery, vendor agreements or patient-facing workflows are compliant.

Current application posture remains `PhiAllowed=false` and production
clinical activation `blocked`. Do not change those flags based on this check.
The owner and counsel must review the executed agreement and service scope,
while engineering must qualify the exact deployed configuration and complete
hosted/device acceptance before any separate PHI activation decision.
