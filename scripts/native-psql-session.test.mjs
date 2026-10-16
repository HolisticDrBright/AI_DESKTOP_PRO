import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { psqlSender } from './native-psql-session.mjs';

/**
 * psql writes query output and `\echo` to stdout and errors to stderr: two pipes, read independently. Under load the
 * stdout marker can be read before the error that preceded it, as one native run observed (a refusal check that saw
 * an empty error). This fake child delivers the stdout marker first and the error afterwards, as that run did.
 */
function fakePsql({ errorLag }) {
  const child = { stdout: new EventEmitter(), stderr: new EventEmitter(), stdin: new EventEmitter() };
  child.stdin.write = (text) => {
    const lines = text.split('\n');
    const failing = lines.some((line) => line.includes('FAIL_ME'));
    const echo = lines.find((line) => line.startsWith('\\echo '))?.slice(6);
    const warn = lines.find((line) => line.startsWith('\\warn '))?.slice(6);
    setImmediate(() => {
      if (!failing) child.stdout.emit('data', 't\n');
      child.stdout.emit('data', `${echo}\n`);
      setTimeout(() => {
        if (failing) child.stderr.emit('data', 'ERROR:  request_context_refused\n');
        if (warn) child.stderr.emit('data', `${warn}\n`);
      }, errorLag);
    });
    return true;
  };
  return child;
}

test('a refusal is returned with the send that raised it, even when stderr is read after the stdout marker', async () => {
  const send = psqlSender(fakePsql({ errorLag: 20 }), 'fake', 'fake_timeout', 2_000);
  const refused = await send('select FAIL_ME;');
  assert.match(refused.error, /request_context_refused/);
  // ...and it is not charged to the next send, whose "no error" would otherwise be wrong both ways.
  const admitted = await send('select true;');
  assert.equal(admitted.error, '');
  assert.equal(admitted.output, 't');
});

test('every native qualification script drives psql through this sender and nothing else', () => {
  for (const script of ['qualify-clinic-status-native.mjs', 'qualify-care-messaging-current-native.mjs', 'qualify-workforce-bootstrap-native.mjs',
    'qualify-workforce-current-authority-native.mjs', 'qualify-workforce-onboarding-native.mjs', 'qualify-synthetic-invitation-native.mjs',
    'qualify-consent-decision-native.mjs', 'qualify-emergency-revocation-native.mjs']) {
    const source = readFileSync(new URL(script, import.meta.url), 'utf8');
    assert.match(source, /from '\.\/native-psql-session\.mjs'/, script);
    assert.match(source, /psqlSender\(child, name, '[a-z_]+_session_timeout'\)/, script);
    assert.doesNotMatch(source, /\\\\echo \$\{id\}/, script);
  }
});
