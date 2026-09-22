import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Logs must carry correlation, never content. Two obligations meet here and can only be satisfied at once if the rule is
 * structural: the cloud agreement asks for the highest level of audit logging and the maximum retention of logs, while
 * the model vendor's terms forbid keeping protected information as a designated record set and exist to minimise what is
 * retained. They reconcile when identifiers are logged and bodies are not, because then a log kept forever holds nothing
 * that a record-set obligation could reach. Keeping that true is a code property, so it is tested like one.
 */
const CONTENT = new Set([
  "transcript", "transcriptText", "answer", "answerText", "payload", "body", "content",
  "prompt", "promptText", "note", "noteText", "message", "messageText", "text",
  "audio", "audioBase64", "email", "firstName", "lastName", "dateOfBirth",
]);
const LOG_CALL = /console\.(?:log|info|warn|error|debug)\s*\(([\s\S]{0,800}?)\);/g;
const STRING = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g;
const REGEX_LITERAL = /\/\^[^\n]*?\/[a-z]*/g;
const HASHED = /\.update\s*\([^()]*\)/g;
const KEY = /([A-Za-z_$][A-Za-z0-9_$]*)\s*:/g;
const CHAIN = /[A-Za-z_$][A-Za-z0-9_$]*(?:\s*\.\s*[A-Za-z_$][A-Za-z0-9_$]*)*/g;

/** What a call would actually write: its object keys and the last segment of every value it reads. */
export function loggedNames(call: string): string[] {
  // A literal is text the author wrote, a hashed argument is a digest, and neither reproduces a record.
  const code = call.replace(STRING, '""').replace(REGEX_LITERAL, "/re/").replace(HASHED, ".update()");
  const names = [...code.matchAll(KEY)].map((match) => match[1]);
  for (const chain of code.match(CHAIN) ?? []) names.push(chain.split(".").pop()!.trim());
  return names;
}

function sources(directory: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(directory)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) out.push(...sources(full));
    else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

describe("logs carry correlation, never content", () => {
  it("logs no field whose name says it holds a body", () => {
    const offenders: string[] = [];
    const files = sources("src/server");
    for (const file of files) {
      for (const match of readFileSync(file, "utf8").matchAll(LOG_CALL)) {
        for (const name of loggedNames(match[1])) {
          if (CONTENT.has(name)) offenders.push(`${file}: ${name} in ${match[1].replace(/\s+/g, " ").slice(0, 120)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
    expect(files.length).toBeGreaterThan(50);
  });

  it("recognises the shapes a body would arrive in, so the guard cannot pass vacuously", () => {
    for (const call of [
      'JSON.stringify({ event: "x", transcript: value })',
      "{ requestId, payload }",
      "record.note",
      "error.message",
      "JSON.parse(response.body)",
    ]) expect(loggedNames(call).filter((name) => CONTENT.has(name))).not.toEqual([]);
  });

  it("does not flag a digest, a count, or a code narrowed out of a body", () => {
    for (const call of [
      'JSON.stringify({ payloadSha256: createHash("sha256").update(payload).digest("hex") })',
      "JSON.stringify({ transcriptCharacters: transcript.length, noteCount: notes.length })",
      'JSON.stringify({ apiStatus: r.statusCode, code: parsed.error })',
      'errorCode(error, "production_migration_verification_failed")',
      '"voice_cleanup_only: message withheld"',
    ]) expect(loggedNames(call).filter((name) => CONTENT.has(name))).toEqual([]);
  });
});
