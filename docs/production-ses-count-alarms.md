# Production SES count-only alarm candidate — October 6, 2026

This is an operational candidate for account `173535830222`, `us-east-2`, not
commercial or PHI activation evidence. It never handles patient data, raw SES
events, or recipient addresses. The source is
`infra/aws-clinical-core/ses-count-only-alarms-candidate.json`.

## Verified prerequisite

The existing SES `alp-transactional` configuration set has an enabled
CloudWatch event destination for `BOUNCE`, `COMPLAINT`, and `REJECT`, with only
the `ses:configuration-set=alp-transactional` dimension. A non-PHI AWS mailbox
simulator send produced one `AWS/SES` `Bounce` datapoint on that dimension.
The separate raw SNS destination was preserved; it still has no processing
subscriber. See the V2 `expo/docs/production-ses-status-2026-10-06.md`.

## Candidate scope and hold

The template creates one **separate** count-only SNS topic and three 5-minute
CloudWatch count alarms. It does not create an email subscription, change the
raw SNS topic, modify the existing reputation-rate alarms, or change SES
sending access. Alarm actions default to **disabled**. Enabling them requires
the exact source commit, a real threshold/recipient review digest, and a real
primary-and-backup responder confirmation digest. SHA-256-shaped strings do
not constitute approval; the operator must inspect the underlying reviews.

Before deployment, verify the exact production account, region, current
configuration-set destination, stack/topic/alarm name availability, and the
reviewed change set. The default thresholds of one event per five minutes are
technical placeholders for review, not an approved on-call policy. A deployed
disabled alarm is not a notification test. Do not subscribe a personal mailbox
to the raw SES event topic: those messages may contain recipient addresses.

Completion still requires confirmed subscriptions on the **count-only** topic,
an enabled alarm-to-response test, reviewed raw-event handling and suppression,
SES production access, and physical registration/reset/invitation delivery
tests. No real patient email, PHI activation, or paid mobile build is permitted
from this candidate.

## Live-state correction — October 14 Pacific / October 15 UTC

Read-only inspection of account `173535830222` in `us-east-2` found SES
production access **enabled**, sending enabled, and the `ailongevitypro.app`
identity verified for sending with DKIM and custom MAIL FROM successful. The
current quota is 50,000 messages per 24 hours and 14 per second. The synthetic
account `588966314750` remains in the SES sandbox. Therefore the production
access prerequisite above is satisfied for transport, but its approved use
case must be reviewed before any marketing send; this does not authorize PHI.

The separate count-only alarm candidate has **not** been observed as a deployed
stack or as count alarms. Two existing `AWS/SES` reputation-rate alarms
(`alp-ses-bounce-rate` and `alp-ses-complaint-rate`) have actions enabled and
target `alp-ses-metric-alarms`; they are not the candidate's per-event count
alarms. That topic has a confirmed subscription for Brandon's backup mailbox,
while the `info@AILongevityPro.app` subscription still reports
`PendingConfirmation`. The distinct `alp-ses-deliverability-alerts` topic has
no subscribers. These observations do not prove bounce suppression, an
alarm-to-human response, or patient email delivery. Reinspect live state before
any future operational change.
