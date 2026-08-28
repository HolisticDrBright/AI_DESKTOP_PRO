# External provider activation

Status as of 2026-08-28: provider boundaries are fail-closed and PHI remains
disabled.

## Identity and recovery

The synthetic consumer account API now owns registration, email confirmation,
resend, recovery request, and recovery confirmation. A confidential Cognito app
client creates immutable person and organization claims; the public mobile app
client can write only the email attribute. Confirmation creates the opaque AWS
clinical identity without storing the email or password in Aurora. Production
registration is intentionally not deployed while PHI activation is blocked.

## Email and messaging

Amazon SES is the selected transactional-email provider in the dedicated
production AWS account. The `ailongevitypro.app` domain identity exists, but it
is pending three DKIM DNS records. AWS denied production-access request
`178794181600116`; the request should be resubmitted only after the domain is
verified and the sending use case is ready for review. No sender is enabled
until DNS verification and AWS production access are both complete. Email notifications must contain only the
minimum necessary content and direct the user to authenticated in-app content.

Secure in-app messaging uses the AWS clinical API and encrypted outbox model.
It is implemented but activation-blocked. SMS stays disabled for PHI because
AWS documents that SNS mobile push and SMS are outside SNS's HIPAA eligibility.
If non-PHI SMS reminders are later desired, they require opt-in, company and
origination registration, production sandbox exit, STOP/HELP handling, and a
hard content policy that excludes health information.

## Subscription billing

The AWS invoice, membership, entitlement, and provider-registration storage is
implemented and activation-blocked. The existing Stripe adapter is test-mode
only, and there are no Stripe credentials in either AWS account. A live payment
provider cannot be registered truthfully until the owner selects and opens the
provider account, App Store payment-policy treatment is decided, PCI scope is
reviewed, and all processor metadata is explicitly PHI-free. Stripe's current
Billing terms prohibit use of Stripe Billing with PHI, so clinical details must
never be sent to the processor.

## The “138 operations” count

The current inventory has 223 operations, all with AWS implementations and all
activation-blocked. The frequently cited 138 are operations whose old Supabase
definitions called `auth.uid()`. They require AWS Cognito request context, which
the production adapter already implements; they are not 138 separate external
provider integrations. Only two legacy operations referenced `auth.users`, and
the AWS workforce invitation/identity boundary replaces those. The inventory
contains zero storage, realtime, vault, or outbound-network provider
dependencies.

The machine-readable snapshot is
`infra/aws-clinical-core/external-provider-readiness.json`.
