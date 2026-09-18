import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Matched provider configuration gate.
 *
 * Every external provider boundary (Zoom, SES reminders, Stripe test mode,
 * Fullscript, consumer account activation) must be disabled by template
 * default, read exactly the variables its Lambda expects, keep secrets out of
 * templates and agree with the recorded provider readiness snapshot. Passing
 * proves consistency only; it is not a signed agreement, production access or
 * PHI activation. */
const root = resolve(process.argv[2] ?? ".");
const read = (file) => readFileSync(resolve(root, file), "utf8");
const errors = [];
const require = (condition, message) => { if (!condition) errors.push(message); };
const json = (file) => { try { return JSON.parse(read(file)); } catch { errors.push(`${file} is missing or invalid JSON`); return null; } };

const readiness = json("infra/aws-clinical-core/external-provider-readiness.json");
if (readiness) {
  require(readiness.phi_allowed === false, "provider readiness must record phi_allowed=false");
  for (const [name, provider] of Object.entries(readiness.providers ?? {})) {
    if ("enabled" in provider) require(provider.enabled === false, `provider ${name} must be recorded as disabled`);
    if ("production_enabled" in provider) require(provider.production_enabled === false, `provider ${name} must be recorded as not production enabled`);
    if ("credentials_present" in provider) require(provider.credentials_present === false, `provider ${name} must not record installed credentials`);
    if ("phi_allowed" in provider) require(provider.phi_allowed === false, `provider ${name} must not allow PHI`);
  }
  require(readiness.providers?.transactional_email?.provider === "amazon_ses", "transactional email provider must be Amazon SES");
  require(readiness.providers?.sms?.enabled === false, "SMS must remain disabled");
}

const telehealth = json("infra/aws-clinical-core/telehealth-requests-extension.json");
const lambdaSource = read("src/server/clinical-core/aws-telehealth-requests-lambda.ts");
if (telehealth) {
  const param = (name) => telehealth.Parameters?.[name] ?? {};
  for (const name of ["ZoomEnabled", "ZoomBaaVerified", "RemindersEnabled", "StripeTestEnabled"]) {
    require(param(name).Default === "false" && JSON.stringify(param(name).AllowedValues) === JSON.stringify(["false", "true"]), `telehealth parameter ${name} must default to false with a boolean allow-list`);
  }
  for (const name of ["ZoomSecretArn", "StripeSecretArn", "ReminderSender"]) require(param(name).Default === "", `telehealth parameter ${name} must default to empty`);
  for (const name of ["StripeSuccessUrl", "StripeCancelUrl"]) require(/^https:\/\/ailongevitypro\.app\//.test(param(name).Default ?? ""), `telehealth parameter ${name} must default to an https ailongevitypro.app URL`);
  const variables = telehealth.Resources?.TelehealthFunction?.Properties?.Environment?.Variables ?? {};
  const expected = new Set([...lambdaSource.matchAll(/required\("([A-Z_]+)"\)/g), ...lambdaSource.matchAll(/process\.env\.([A-Z_]+)/g)].map((m) => m[1]));
  for (const name of expected) require(name in variables, `telehealth template must set ${name}, which the Lambda reads`);
  for (const name of Object.keys(variables)) require(expected.has(name), `telehealth template sets ${name}, which the Lambda never reads`);
  require(JSON.stringify(variables.PHI_ALLOWED ?? "") !== JSON.stringify("true"), "telehealth PHI_ALLOWED must never be a literal true");
}
const handler = read("src/server/clinical-core/aws-telehealth-requests.ts");
require(handler.includes('(config.zoomEnabled && (!config.zoomBaaVerified || !config.zoomSecretArn))'), "Zoom must require the recorded BAA gate and secret before enabling");
require(handler.includes('if (item.status === "cancelled" || item.scheduledStart !== event.scheduledStart) return { sent: false, reason: "stale" };'), "reminders must refuse stale or cancelled appointments");
require(handler.includes('if (parsed.livemode === true) throw new TelehealthError("request_invalid");'), "Stripe webhooks must refuse live-mode events");
require(handler.includes('Math.abs(Date.now() / 1000 - epoch) > 300'), "Stripe webhook signatures must enforce a five-minute replay window");
require(handler.includes('if (!secretKey.startsWith("sk_test_") && !secretKey.startsWith("rk_test_")) throw new TelehealthError("provider_unavailable");'), "Stripe credentials must be test-mode only");
require(handler.includes('if (value.action === "reconcile") return reconcilePayment(config, actor, value);'), "workforce payment reconciliation must be available for processing charges");

const fullscript = json("infra/aws-clinical-core/fullscript-connector-extension.json");
if (fullscript) {
  require(fullscript.Parameters?.FullscriptEnvironment?.Default === "sandbox_us", "Fullscript must default to the sandbox environment");
  require(fullscript.Parameters?.FullscriptClientSecret?.NoEcho === true, "Fullscript client secret parameter must be NoEcho");
  require(!fullscript.Parameters?.FullscriptClientSecret?.Default, "Fullscript client secret must have no default");
}
const account = json("infra/aws-clinical-core/consumer-account-extension.json");
if (account) require(account.Parameters?.AccountActivation?.Default === "blocked", "consumer account activation must default to blocked");

for (const file of ["telehealth-requests-extension.json", "fullscript-connector-extension.json", "consumer-account-extension.json", "external-provider-readiness.json"]) {
  const text = read(`infra/aws-clinical-core/${file}`);
  require(!/sk_live_|sk_test_[A-Za-z0-9]{8,}|whsec_[A-Za-z0-9]{8,}|-----BEGIN|AKIA[0-9A-Z]{16}/.test(text), `${file} must not contain credential material`);
}

if (errors.length) {
  for (const error of errors) console.error(`AWS provider configuration check failed: ${error}`);
  process.exitCode = 1;
} else {
  console.log("AWS provider configuration check passed: Zoom, SES reminders, Stripe test mode, Fullscript and consumer activation are disabled by default, credential-free and matched to their runtimes. Not provider approval or PHI activation.");
}
