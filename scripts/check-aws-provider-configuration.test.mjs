import assert from "node:assert/strict";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const script = new URL("./check-aws-provider-configuration.mjs", import.meta.url).pathname.replace(/^\/(.:)/, "$1");
function fixture(mutate = () => {}) {
  const directory = mkdtempSync(join(tmpdir(), "provider-configuration-"));
  mkdirSync(join(directory, "infra/aws-clinical-core"), { recursive: true });
  mkdirSync(join(directory, "src/server/clinical-core"), { recursive: true });
  mkdirSync(join(directory, "src/server/calendar"), { recursive: true });
  for (const file of ["telehealth-requests-extension.json", "fullscript-connector-extension.json", "consumer-account-extension.json", "external-provider-readiness.json"])
    cpSync(join("infra/aws-clinical-core", file), join(directory, "infra/aws-clinical-core", file));
  for (const file of ["aws-telehealth-requests-lambda.ts", "aws-telehealth-requests.ts"]) cpSync(join("src/server/clinical-core", file), join(directory, "src/server/clinical-core", file));
  cpSync("src/server/calendar/externalCalendarSync.ts", join(directory, "src/server/calendar/externalCalendarSync.ts"));
  mutate(directory);
  return spawnSync(process.execPath, [script, directory], { encoding: "utf8" });
}
const edit = (directory, file, change) => {
  const path = join(directory, file); const value = JSON.parse(readFileSync(path, "utf8")); change(value); writeFileSync(path, JSON.stringify(value));
};
const clean = fixture();
assert.equal(clean.status, 0, clean.stderr);
assert.match(clean.stdout, /check passed/);

const zoom = fixture((d) => edit(d, "infra/aws-clinical-core/telehealth-requests-extension.json", (t) => { t.Parameters.ZoomEnabled.Default = "true"; }));
assert.equal(zoom.status, 1); assert.match(zoom.stderr, /ZoomEnabled must default to false/);

const drift = fixture((d) => edit(d, "infra/aws-clinical-core/telehealth-requests-extension.json", (t) => { delete t.Resources.TelehealthFunction.Properties.Environment.Variables.ZOOM_BAA_VERIFIED; }));
assert.equal(drift.status, 1); assert.match(drift.stderr, /must set ZOOM_BAA_VERIFIED/);

const enabled = fixture((d) => edit(d, "infra/aws-clinical-core/external-provider-readiness.json", (t) => { t.providers.transactional_email.enabled = true; }));
assert.equal(enabled.status, 1); assert.match(enabled.stderr, /transactional_email must be recorded as disabled/);

const secret = fixture((d) => edit(d, "infra/aws-clinical-core/fullscript-connector-extension.json", (t) => { t.Parameters.FullscriptClientSecret.Default = "sk_test_ABCDEFGHIJKLMNOP"; }));
assert.equal(secret.status, 1); assert.match(secret.stderr, /must not contain credential material/);

const calendarWriteScope = fixture((d) => {
  const path = join(d, "src/server/calendar/externalCalendarSync.ts");
  writeFileSync(path, readFileSync(path, "utf8").replaceAll('calendar.freebusy', 'calendar.events'));
});
assert.equal(calendarWriteScope.status, 1); assert.match(calendarWriteScope.stderr, /external calendar must not allow a write scope/);

const calendarNetwork = fixture((d) => {
  const path = join(d, "src/server/calendar/externalCalendarSync.ts");
  writeFileSync(path, readFileSync(path, "utf8") + '\nfetch("https://fictional.invalid");\n');
});
assert.equal(calendarNetwork.status, 1); assert.match(calendarNetwork.stderr, /must stay credential-free and make no provider call/);

function reminderFixture(before, after) {
  return fixture((d) => {
    const path = join(d, "src/server/clinical-core/aws-telehealth-requests.ts");
    const source = readFileSync(path, "utf8").replaceAll("\r\n", "\n");
    assert.ok(source.includes(before), `mutation must touch executable source: ${before}`);
    writeFileSync(path, source.replace(before, after));
  });
}
const reminderMutations = [
  ['if (item.mutationOperationId) return "change_pending";', '// if (item.mutationOperationId) return "change_pending";'],
  ['item.reminderStatus !== "scheduled" || ', ''],
  ['!["scheduled", "awaiting_provider"].includes(item.status)', '!["scheduled", "awaiting_provider", "cancelled"].includes(item.status)'],
  ['|| item.scheduledStart !== event.scheduledStart', ''],
  ['event.reminderProtocol === undefined && event.reminderGeneration === undefined ? null : "stale"', 'null'],
  ['typeof item.reminderGeneration === "string" && UUID.test(item.reminderGeneration)', 'true'],
  ['event.reminderProtocol === "appointment-reminder/2"', 'true'],
  ['event.reminderGeneration === item.reminderGeneration ? null : "stale"', 'true ? null : "stale"'],
  ['const refusal = reminderRefusal(item, event);', 'const refusal = null; // reminderRefusal(item, event);'],
  ['if (refusal) return { sent: false, reason: refusal };', '// if (refusal) return { sent: false, reason: refusal };'],
  ['if (await emailSuppressed(config, item.consumerEmail)) return { sent: false, reason: "suppressed" };', '// suppression ignored'],
  ['const current = await find(config, String(event.organizationId), String(event.requestId));', 'const current = item;'],
  ['const currentRefusal = reminderRefusal(current, event);', 'const currentRefusal = null;'],
  ['if (currentRefusal) return { sent: false, reason: currentRefusal };', '// current refusal ignored'],
  ['current.version !== item.version || ', ''],
  ['current.consumerPersonId !== item.consumerPersonId', 'false'],
  ['current.consumerEmail !== item.consumerEmail', 'false'],
  ['current.joinUrl !== item.joinUrl', 'false'],
  ['ToAddresses: [current.consumerEmail]', 'ToAddresses: [item.consumerEmail]'],
  // The expected guard text elsewhere must not satisfy an absent executable helper.
  ['function reminderRefusal(item:', 'function ignoredReminderRefusal(item:'],
  ['async function sendAppointmentReminder(config:', 'async function ignoredSendAppointmentReminder(config:'],
  ['if (!config.remindersEnabled || !UUID.test(String(event.organizationId))', 'if (!UUID.test(String(event.organizationId))'],
];
for (const [before, after] of reminderMutations) {
  const result = reminderFixture(before, after);
  assert.equal(result.status, 1, `gate admitted unsafe reminder mutation: ${before}`);
  assert.match(result.stderr, /reminders must/);
}
const formatted = reminderFixture('if (item.mutationOperationId) return "change_pending";',
  'if ( /* reviewed comment */ item.mutationOperationId )\n    return "change_pending";');
assert.equal(formatted.status, 0, formatted.stderr);
const malformed = reminderFixture('function reminderRefusal(item:', 'function reminderRefusal(]:');
assert.equal(malformed.status, 1); assert.match(malformed.stderr, /reminder source must parse/);
console.log("check-aws-provider-configuration tests passed");
