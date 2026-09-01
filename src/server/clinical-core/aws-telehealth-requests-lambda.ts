if (typeof window !== "undefined") throw new Error("aws-telehealth-requests-lambda is server-only");
import { createTelehealthHandler } from "./aws-telehealth-requests";
const required = (name: string) => { const value = process.env[name]?.trim(); if (!value) throw new Error("telehealth_configuration_missing"); return value; };
export const handler = createTelehealthHandler({
  tableName: required("TELEHEALTH_TABLE_NAME"), consumerIssuer: required("CLINICAL_CONSUMER_ISSUER"),
  consumerAudience: required("CLINICAL_CONSUMER_AUDIENCE"), workforceIssuer: required("CLINICAL_WORKFORCE_ISSUER"),
  workforceAudience: required("CLINICAL_WORKFORCE_AUDIENCE"), runtimeMode: required("RUNTIME_MODE") === "production" ? "production" : "synthetic",
  phiAllowed: required("PHI_ALLOWED") === "true", zoomEnabled: required("ZOOM_ENABLED") === "true",
  zoomBaaVerified: required("ZOOM_BAA_VERIFIED") === "true", zoomSecretArn: process.env.ZOOM_SECRET_ARN?.trim() ?? "",
  remindersEnabled: required("REMINDERS_ENABLED") === "true", reminderSender: process.env.REMINDER_SENDER?.trim() ?? "",
  reminderConfigurationSet: process.env.REMINDER_CONFIGURATION_SET?.trim() ?? "", reminderScheduleGroup: process.env.REMINDER_SCHEDULE_GROUP?.trim() ?? "",
  reminderSchedulerRoleArn: process.env.REMINDER_SCHEDULER_ROLE_ARN?.trim() ?? "", reminderTargetArn: process.env.REMINDER_TARGET_ARN?.trim() ?? "",
  stripeTestEnabled: required("STRIPE_TEST_ENABLED") === "true", stripeSecretArn: process.env.STRIPE_SECRET_ARN?.trim() ?? "",
  stripeSuccessUrl: process.env.STRIPE_SUCCESS_URL?.trim() ?? "", stripeCancelUrl: process.env.STRIPE_CANCEL_URL?.trim() ?? "",
});
