import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";

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
// Compare parsed executable statements, not a source substring that can survive
// in a comment or an unrelated function. This is a deliberately reviewed
// source-shape gate, not a substitute for the reminder race/runtime tests.
const parsedHandler = ts.createSourceFile("telehealth.ts", handler, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });
const statements = (nodes, source) => nodes.map(node => printer.printNode(ts.EmitHint.Unspecified, node, source)).join("\n");
function functionStatements(name) {
  const declarations = parsedHandler.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  return declarations.length === 1 && declarations[0].body ? declarations[0].body.statements : [];
}
function reviewedStatements(source) {
  const parsed = ts.createSourceFile("reviewed.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  return statements([...parsed.statements], parsed);
}
require(parsedHandler.parseDiagnostics.length === 0, "reminder source must parse before its safety gate can pass");
const refusalStatements = functionStatements("reminderRefusal");
require(statements([...refusalStatements], parsedHandler) === reviewedStatements(`
  if (item.mutationOperationId) return "change_pending";
  if (item.reminderStatus !== "scheduled" || !["scheduled", "awaiting_provider"].includes(item.status)
    || item.scheduledStart !== event.scheduledStart) return "stale";
  if (item.reminderGeneration === undefined) {
    return event.reminderProtocol === undefined && event.reminderGeneration === undefined ? null : "stale";
  }
  return typeof item.reminderGeneration === "string" && UUID.test(item.reminderGeneration)
    && event.reminderProtocol === "appointment-reminder/2" && event.reminderGeneration === item.reminderGeneration ? null : "stale";
`), "reminders must refuse pending, stale, cancelled and mismatched-generation appointments");
const deliveryStatements = functionStatements("sendAppointmentReminder");
require(statements([...deliveryStatements].slice(0, 9), parsedHandler) === reviewedStatements(`
  if (!config.remindersEnabled || !UUID.test(String(event.organizationId)) || !UUID.test(String(event.requestId)) || !date(String(event.scheduledStart))) throw new TelehealthError("service_unavailable");
  const item = await find(config, String(event.organizationId), String(event.requestId));
  const refusal = reminderRefusal(item, event);
  if (refusal) return { sent: false, reason: refusal };
  if (await emailSuppressed(config, item.consumerEmail)) return { sent: false, reason: "suppressed" };
  const current = await find(config, String(event.organizationId), String(event.requestId));
  const currentRefusal = reminderRefusal(current, event);
  if (currentRefusal) return { sent: false, reason: currentRefusal };
  if (current.version !== item.version || current.consumerPersonId !== item.consumerPersonId
    || current.consumerEmail !== item.consumerEmail || current.joinUrl !== item.joinUrl) return { sent: false, reason: "stale" };
`), "reminders must enforce both refusal checks and a fresh revision after suppression lookup");
const delivery = statements([...deliveryStatements], parsedHandler);
require(delivery.includes("ToAddresses: [current.consumerEmail]") && !delivery.includes("ToAddresses: [item.consumerEmail]"),
  "reminders must deliver only to the rechecked recipient");
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
// The external calendar connector is source-only and has no template yet, so its posture is
// asserted where it actually lives: the module must be disabled without an explicit opt-in,
// must accept only read-only scopes, and must hold no credential or network call.
const calendar = read("src/server/calendar/externalCalendarSync.ts");
if (calendar) {
  require(/EXTERNAL_CALENDAR_ENABLED \?\? ''\)\.trim\(\) === '1'/.test(calendar.replace(/"/g, "'")),
    "external calendar must require an explicit EXTERNAL_CALENDAR_ENABLED=1");
  require(!/auth\/calendar'/.test(calendar) && !/auth\/calendar\.events'/.test(calendar),
    "external calendar must not allow a write scope");
  require(/calendar\.freebusy/.test(calendar), "external calendar must offer the busy-time scope");
  require(!/fetch\(|oauth2\.googleapis\.com|client_secret=|apps\.googleusercontent\.com/.test(calendar),
    "external calendar core must stay credential-free and make no provider call");
  require(/CLIENT_SECRET_ARN/.test(calendar), "external calendar must reference its secret by ARN name, never a value");
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
  console.log("AWS provider configuration check passed: Zoom, SES reminders, Stripe test mode, Fullscript, the external calendar connector and consumer activation are disabled by default, credential-free and matched to their runtimes. Not provider approval or PHI activation.");
}
