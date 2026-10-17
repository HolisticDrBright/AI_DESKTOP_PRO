/**
 * Hosted program ACCEPTANCE for the Desktop synthetic API: a separate path from the hosted smoke scripts, which stay smoke.
 *
 * A run is accepted only on values this process observed for itself (scripts/hosted-program-acceptance-observation.mjs):
 * - the stack-advertised Desktop commit must equal the reviewed 40-character commit;
 * - the live `CodeSha256` must equal the reviewed artifact, whose `index.js` must be the bundle pinned for that commit;
 * - the authorizers, the function and every token must name the synthetic pools;
 * - every answer must carry `x-clinical-execution: qualification` (an unmarked 401/403 is counted, never classifies);
 * - the target must be unchanged between the observation before the run and the one after it.
 * A caller-supplied deployment file is only ever compared against the observation; it never replaces it.
 *
 * Writes are recorded as `created`, `reused`, `skipped` or `refused`, each against an answer this run observed. A replay
 * the server reported is never creation, and a step the plan says must be created this run is refused when it was
 * reused or skipped. No purchase step is ever sent or accepted: no store or provider purchase can be observed here, and
 * provider-shaped JSON (a checkout session, a store transaction, a Fullscript plan) is refused wherever it appears.
 *
 * Only the AWS CLI reader and the global-fetch transport built in the observation module, with the reviewed pair, can
 * yield `accepted`. With injected (fictional) adapters the best verdict is `fictional_only_not_hosted_evidence`.
 *
 * Command (read-only; it observes and checks the binding, and sends no API request):
 *   node scripts/hosted-program-acceptance.mjs --observe-read-only [--reviewed-artifact=<abs zip>] [--deployment-claim=<abs json>]
 */
import {createHash} from 'node:crypto';
import {lstatSync, readFileSync} from 'node:fs';
import {isAbsolute, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {careReleaseZip} from './synthetic-care-release.mjs';
import {PROGRAM_TARGET, HostedObservationError, createAwsCliReader, createWriteLedger, isAdapterObservation,
  isObservedIdentity, isObservedResponse, observeIdentityToken, observeProgramTarget, replayIndicated,
  classifyWrite} from './hosted-program-acceptance-observation.mjs';

/** The reviewed Desktop half of the selected code pair (docs/codex-hosted-qualification-packet-2026-10-17.md §1-2).
 * A new pair is a reviewed source change of these values.
 *
 * The identity bundle digest is deliberately unpinned. The unminified bundle keeps a `// <path>` comment per module,
 * relative to the build root, so its bytes depend on where `node_modules` sits: the same `8bfe2349` source gave
 * `24a65189…` (1,980,414 bytes) from a deep scratch root and `546d962f…` (1,950,986 bytes) from `/home/user/<dir>`,
 * both through a symlinked `node_modules`. Neither is the digest of a reviewed build. Until a clean `npm ci` build
 * of the reviewed commit records it here in a reviewed change, every artifact refuses `reviewed_bundle_unpinned`. */
export const REVIEWED_SOURCE_PAIR = Object.freeze({
  contract: 'desktop-reviewed-source-pair/1',
  desktopCommit: '8bfe2349af869cbc0d93712fe6050300bb4ce4ab',
  v2Commit: 'dd704abf820de5556c5e6da9dcb39495c138fa87',
  identityBundleSha256: null,
  identityBundleBytes: null,
});

export class AcceptanceRefusedError extends Error {
  constructor(refusals, report = null) {
    super(`hosted_program_acceptance_refused:${refusals.join(',')}`);
    this.name = 'AcceptanceRefusedError'; this.refusals = [...refusals]; this.report = report;
  }
}
const sha256 = value => createHash('sha256').update(value).digest('hex');
const HEX40 = /^[a-f0-9]{40}$/, HEX64 = /^[a-f0-9]{64}$/;
const STACK_COMPLETE = new Set(['CREATE_COMPLETE', 'UPDATE_COMPLETE']);
const PURCHASE_KINDS = new Set(['purchase', 'store_purchase', 'provider_purchase', 'checkout', 'subscription']);
const ROLE_POOL = Object.freeze({consumer: 'consumer', foreignConsumer: 'consumer', workforce: 'workforce'});

function storedEntries(zip, fail) {
  const entries = [];
  let offset = 0;
  while (offset + 30 <= zip.length && zip.readUInt32LE(offset) === 0x04034b50) {
    const flags = zip.readUInt16LE(offset + 6), method = zip.readUInt16LE(offset + 8), size = zip.readUInt32LE(offset + 18);
    const raw = zip.readUInt32LE(offset + 22), nameLength = zip.readUInt16LE(offset + 26), extra = zip.readUInt16LE(offset + 28);
    const start = offset + 30 + nameLength + extra;
    if (flags !== 0 || method !== 0 || size !== raw || start + size > zip.length) fail('reviewed_artifact_invalid');
    entries.push({name: zip.subarray(offset + 30, offset + 30 + nameLength).toString('utf8'), data: zip.subarray(start, start + size)});
    offset = start + size;
  }
  if (offset + 4 > zip.length || zip.readUInt32LE(offset) !== 0x02014b50) fail('reviewed_artifact_invalid');
  return entries;
}
/** The reviewed artifact is checked against the pinned bundle, not trusted: its `index.js` must be the bundle pinned for
 * the reviewed commit, its release record must name that commit, and it must be the canonical care-release ZIP. */
export function verifyReviewedArtifact(zip, pair = REVIEWED_SOURCE_PAIR) {
  const fail = code => {throw new AcceptanceRefusedError([code]);};
  if (!Buffer.isBuffer(zip) || zip.length === 0 || zip.length > 16 * 1024 * 1024) fail('reviewed_artifact_invalid');
  const entries = storedEntries(zip, fail);
  if (entries.length !== 2 || entries[0].name !== 'index.js' || entries[1].name !== 'release.json') fail('reviewed_artifact_invalid');
  const bundle = Buffer.from(entries[0].data);
  if (!HEX64.test(pair?.identityBundleSha256 ?? '') || !Number.isInteger(pair?.identityBundleBytes)) fail('reviewed_bundle_unpinned');
  if (bundle.length !== pair.identityBundleBytes || sha256(bundle) !== pair.identityBundleSha256) fail('reviewed_bundle_mismatch');
  let release;
  try {release = JSON.parse(entries[1].data.toString('utf8'));} catch {fail('reviewed_artifact_invalid');}
  if (release?.desktop?.commit !== pair.desktopCommit) fail('reviewed_artifact_source_mismatch');
  if (release.bundleSha256 !== sha256(bundle) || release.execution !== 'synthetic-staging' || release.phiAllowed !== false) fail('reviewed_artifact_invalid');
  if (!careReleaseZip(bundle, release).equals(zip)) fail('reviewed_artifact_not_canonical');
  return {zipSha256: sha256(zip), zipBytes: zip.length, bundleSha256: sha256(bundle), desktopCommit: release.desktop.commit,
    mobileCommit: release.mobile?.source?.commit ?? null, releaseContract: release.contract ?? null};
}

const claimDigest = value => typeof value !== 'string' ? 'unparseable' : HEX64.test(value) ? value
  : /^[A-Za-z0-9+/]{43}=$/.test(value) ? Buffer.from(value, 'base64').toString('hex') : 'unparseable';
function identityRefusals(identity, target) {
  const pool = ROLE_POOL[identity.role];
  if (!pool) return ['identity_role_refused'];
  const codes = [];
  if (identity.iss !== target[pool].issuer) codes.push('issuer_mismatch');
  if (identity.aud !== target[pool].audience) codes.push('audience_mismatch');
  if (identity.tokenUse !== 'id') codes.push('identity_token_refused');
  if (!identity.syntheticAttested) codes.push('identity_not_synthetic');
  if (identity.productionBound) codes.push('phi_posture_refused');
  return codes;
}

/** Binds an observation to the reviewed pair. The deployment claim, when given, is compared and never relied on. */
export function evaluateTargetBinding({observation, pair = REVIEWED_SOURCE_PAIR, artifact, deploymentClaim, target = PROGRAM_TARGET} = {}) {
  const refusals = new Set();
  const expectedCommit = typeof pair?.desktopCommit === 'string' && HEX40.test(pair.desktopCommit) ? pair.desktopCommit : null;
  if (!expectedCommit) refusals.add('expected_source_invalid');
  let reviewed = null;
  if (artifact === undefined || artifact === null) refusals.add('reviewed_artifact_required');
  else {
    try {reviewed = verifyReviewedArtifact(artifact, pair);} catch (error) {for (const code of error.refusals ?? ['reviewed_artifact_invalid']) refusals.add(code);}
  }
  let observed = null, observationValid = false;
  if (observation === undefined || observation === null) refusals.add('observation_required');
  else if (!isAdapterObservation(observation)) refusals.add('observation_not_from_adapter');
  else {
    observationValid = true;
    const o = observation;
    const stackSignals = [o.stack.key.desktopCommit, o.stack.sourceCommitParameter, o.stack.sourceCommitOutput].filter(v => v !== null);
    const signals = [...stackSignals, ...(o.function.sourceCommitEnvironment === null ? [] : [o.function.sourceCommitEnvironment])];
    const agreed = stackSignals.length > 0 && !signals.includes('invalid') && new Set(signals).size === 1;
    observed = {account: o.account, transport: o.transport, observedAt: o.observedAt, desktopCommit: agreed ? signals[0] : null,
      sourceSignals: signals, keyFamily: o.stack.key.family, lambdaCodeKey: o.stack.lambdaCodeKey,
      stackCodeSha256: o.stack.key.zipSha256, codeSha256: o.function.codeSha256Hex, revisionId: o.function.revisionId};
    if (o.account !== target.account || !String(o.principalArn ?? '').startsWith(`arn:aws:sts::${target.account}:assumed-role/`)) refusals.add('account_refused');
    if (!STACK_COMPLETE.has(o.stack.status) || !STACK_COMPLETE.has(o.foundation.status)) refusals.add('stack_not_complete');
    if (o.foundation.phiAllowed !== 'false' || o.foundation.dataClassification !== 'synthetic_only') refusals.add('phi_posture_refused');
    if (stackSignals.length === 0) refusals.add('stack_source_unadvertised');
    else if (!agreed) refusals.add('stack_source_signals_disagree');
    else if (expectedCommit && observed.desktopCommit !== expectedCommit) refusals.add('observed_source_stale');
    if (o.function.state !== 'Active' || o.function.lastUpdateStatus !== 'Successful') refusals.add('function_not_active');
    if (!o.function.codeSha256Hex) refusals.add('function_code_unobserved');
    else {
      if (o.stack.key.zipSha256 && o.stack.key.zipSha256 !== o.function.codeSha256Hex) refusals.add('stack_code_pointer_disagrees');
      if (reviewed && o.function.codeSha256Hex !== reviewed.zipSha256) refusals.add('observed_code_stale');
    }
    for (const pool of ['consumer', 'workforce']) {
      const expected = target[pool];
      if (o.function[`${pool}Issuer`] !== expected.issuer) refusals.add('issuer_mismatch');
      if (o.function[`${pool}Audience`] !== expected.audience) refusals.add('audience_mismatch');
      const matching = o.authorizers.filter(a => a.issuer === expected.issuer);
      if (matching.length !== 1 || matching[0].type !== 'JWT') refusals.add('issuer_mismatch');
      else if (matching[0].audiences.length !== 1 || matching[0].audiences[0] !== expected.audience) refusals.add('audience_mismatch');
    }
    if (o.authorizers.some(a => a.issuer !== target.consumer.issuer && a.issuer !== target.workforce.issuer)) refusals.add('issuer_mismatch');
  }
  let claim = 'absent';
  if (deploymentClaim !== undefined && deploymentClaim !== null) {
    const c = typeof deploymentClaim === 'object' && !Array.isArray(deploymentClaim) ? deploymentClaim : {};
    const commits = [c.sourceCommit, c.deployedSourceCommit, c.desktopCommit, c.desktopStackCommit, c.desktop?.commit].filter(v => v !== undefined && v !== null);
    const codes = [c.deployedCodeSha256, c.codeSha256, c.zipSha256, c.artifactSha256, c.deployedArtifactSha256]
      .filter(v => v !== undefined && v !== null).map(claimDigest);
    if (commits.length === 0 && codes.length === 0) {claim = 'unbound'; refusals.add('deployment_claim_unbound');}
    else if (!observationValid) claim = 'unverifiable';
    else if (commits.some(v => v !== observed.desktopCommit) || codes.some(v => v !== observed.codeSha256)) {
      claim = 'disagrees'; refusals.add('deployment_claim_disagrees');
    } else claim = 'agrees';
  }
  return {refusals: [...refusals].sort(), observationValid, reviewed, observed, deploymentClaim: claim,
    expected: {desktopCommit: expectedCommit, codeSha256: reviewed?.zipSha256 ?? null, bundleSha256: reviewed?.bundleSha256 ?? null}};
}

/** What the read-only command prints: the binding only. It never says a journey was accepted. */
export function targetBindingReport(binding, {pair = REVIEWED_SOURCE_PAIR, target = PROGRAM_TARGET} = {}) {
  const hosted = binding.observationValid && binding.observed.transport === 'aws-cli' && pair === REVIEWED_SOURCE_PAIR && target === PROGRAM_TARGET;
  return {contract: 'hosted-program-target-binding/1',
    verdict: binding.refusals.length ? 'refused' : hosted ? 'binding_observed' : 'fictional_only_not_hosted_evidence',
    refusals: binding.refusals, expected: binding.expected, observed: binding.observed, deploymentClaim: binding.deploymentClaim,
    journeyAcceptance: false, apiRequestsSent: 0, awsMutationPerformed: false, phiAllowed: false};
}

const PROVIDER_KEYS = new Set(['payment_status', 'payment_intent', 'client_secret', 'checkout_session', 'latest_receipt',
  'latest_receipt_info', 'receipt-data', 'signedTransactionInfo', 'signedRenewalInfo', 'originalTransactionId', 'transactionId',
  'webOrderLineItemId', 'purchaseToken', 'orderId', 'purchaseState', 'acknowledgementState', 'obfuscatedExternalAccountId',
  'treatment_plan', 'treatment_plans', 'fullscript', 'provider', 'providerResponse', 'stripe']);
const STRIPE_OBJECT = /^(checkout\.session|payment_intent|charge|invoice|subscription|refund|event|customer)$/;
const STRIPE_ID = /^(cs|pi|ch|in|sub|evt|re|cus)_(test|live)_/;
/** Whether a value looks like a store, payment or supplier payload anywhere within it. */
export function providerShaped(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 8) return false;
  if (Array.isArray(value)) return value.some(item => providerShaped(item, depth + 1));
  for (const [key, item] of Object.entries(value)) {
    if (PROVIDER_KEYS.has(key)) return true;
    if (key === 'object' && typeof item === 'string' && STRIPE_OBJECT.test(item)) return true;
    if (key === 'id' && typeof item === 'string' && STRIPE_ID.test(item)) return true;
    if (providerShaped(item, depth + 1)) return true;
  }
  return false;
}

const fingerprint = o => JSON.stringify([o.stack.status, o.stack.lambdaCodeKey, o.stack.sourceCommitParameter, o.stack.sourceCommitOutput,
  o.foundation.phiAllowed, o.function, o.authorizers]);
const REFUSAL_STATUSES = [401, 403, 404, 409, 422];
function entryRefusals(planned, entry) {
  const {step, requirement} = planned, r = entry.response, observed = r !== null && isObservedResponse(r), codes = [];
  if (r !== null && !observed) codes.push('response_not_from_transport');
  if (observed && providerShaped(r.body)) codes.push(`provider_shaped_evidence:${step}`);
  const answered = observed && r.status >= 200 && r.status < 300 && r.execution === 'qualification';
  if (entry.outcome === 'created') {
    if (!answered) codes.push(`created_without_observed_response:${step}`);
    else if (replayIndicated(r)) codes.push(`replay_counted_as_creation:${step}`);
  }
  if (entry.outcome === 'reused' && !answered) codes.push(`reuse_not_observed:${step}`);
  if (entry.outcome === 'refused' && !(observed && REFUSAL_STATUSES.includes(r.status) && r.execution !== 'production')) codes.push(`refusal_not_observed:${step}`);
  if (requirement === 'must_create' && entry.outcome !== 'created') codes.push(`mandatory_create_not_observed:${step}`);
  if (requirement === 'create_or_reuse' && !['created', 'reused'].includes(entry.outcome)) codes.push(`mandatory_step_skipped:${step}`);
  if (requirement === 'must_replay' && !(entry.outcome === 'reused' && observed && replayIndicated(r))) codes.push(`replay_not_observed:${step}`);
  if (requirement === 'must_refuse' && entry.outcome !== 'refused') codes.push(`refusal_not_observed:${step}`);
  if (!['must_refuse', 'optional'].includes(requirement) && entry.outcome === 'refused') codes.push(`unexpected_refusal:${step}`);
  return codes;
}

/** The acceptance verdict over one run: the target before and after, the identities, every answer, the write ledger
 * and any extra evidence the caller wants admitted. Every input is checked against what the adapters produced. */
export function evaluateHostedProgramAcceptance({before, after, pair = REVIEWED_SOURCE_PAIR, artifact, deploymentClaim,
  target = PROGRAM_TARGET, identities = [], responses = [], ledger, evidence = []} = {}) {
  const binding = evaluateTargetBinding({observation: before, pair, artifact, deploymentClaim, target});
  const refusals = new Set(binding.refusals);
  if (after === undefined || after === null) refusals.add('observation_required');
  else if (!isAdapterObservation(after)) refusals.add('observation_not_from_adapter');
  else if (binding.observationValid && fingerprint(before) !== fingerprint(after)) refusals.add('target_changed_during_run');
  const roles = new Set();
  for (const identity of identities) {
    if (!isObservedIdentity(identity)) {refusals.add('identity_not_from_adapter'); continue;}
    roles.add(identity.role);
    for (const code of identityRefusals(identity, target)) refusals.add(code);
  }
  const modes = new Set();
  let marked = 0, unmarkedDenials = 0;
  for (const r of responses) {
    if (!isObservedResponse(r)) {refusals.add('response_not_from_transport'); continue;}
    if (r.role !== null && !roles.has(r.role)) refusals.add('identity_not_observed');
    if (providerShaped(r.body)) refusals.add('provider_shaped_evidence');
    if (r.execution === 'unmarked_denial') unmarkedDenials++;
    else {modes.add(r.execution); if (r.execution === 'qualification') marked++;}
  }
  const execution = modes.size === 0 ? 'unobserved' : modes.size > 1 ? 'mixed' : modes.has('qualification') ? 'qualification' : 'production';
  if (execution === 'unobserved') refusals.add('execution_unobserved');
  else if (execution !== 'qualification') refusals.add('execution_not_qualification');
  const counts = {created: 0, reused: 0, skipped: 0, refused: 0}, steps = [];
  if (ledger !== undefined) {
    const plan = ledger?.plan, entries = typeof ledger?.entries === 'function' ? ledger.entries() : null;
    if (!Array.isArray(plan) || !Array.isArray(entries)) refusals.add('ledger_invalid');
    else {
      const planned = new Set(plan.map(p => p.step));
      for (const entry of entries) if (!planned.has(entry.step)) refusals.add(`step_unplanned:${entry.step}`);
      for (const p of plan) {
        if (PURCHASE_KINDS.has(p.kind)) refusals.add(`purchase_simulation_refused:${p.step}`);
        const mine = entries.filter(entry => entry.step === p.step);
        if (mine.length === 0) refusals.add(`step_not_recorded:${p.step}`);
        if (mine.length > 1) refusals.add(`step_recorded_twice:${p.step}`);
        for (const entry of mine) for (const code of entryRefusals(p, entry)) refusals.add(code);
        const outcome = mine[0]?.outcome ?? 'not_recorded';
        if (outcome in counts) counts[outcome]++;
        steps.push({step: p.step, kind: p.kind, requirement: p.requirement, outcome, reason: mine[0]?.reason ?? null});
      }
    }
  }
  for (const item of evidence) {
    const observed = isObservedResponse(item);
    if (!observed) refusals.add('evidence_not_observed');
    if (providerShaped(observed ? item.body : item)) refusals.add('provider_shaped_evidence');
  }
  const reviewedPair = pair === REVIEWED_SOURCE_PAIR && target === PROGRAM_TARGET;
  const hostedTransport = binding.observationValid && before.transport === 'aws-cli' && isAdapterObservation(after) && after.transport === 'aws-cli'
    && responses.length > 0 && responses.every(r => isObservedResponse(r) && r.transport === 'https-fetch');
  const satisfied = refusals.size === 0;
  return {contract: 'hosted-program-acceptance/1', mode: 'acceptance',
    verdict: !satisfied ? 'refused' : hostedTransport && reviewedPair ? 'accepted' : 'fictional_only_not_hosted_evidence',
    hostedEvidence: satisfied && hostedTransport && reviewedPair, refusals: [...refusals].sort(),
    pair: {desktopCommit: binding.expected.desktopCommit, reviewed: reviewedPair}, expected: binding.expected, observed: binding.observed,
    deploymentClaim: binding.deploymentClaim, execution: {execution, unmarkedDenials, marked, responses: responses.length},
    writes: {...counts, steps}, purchasesObserved: 0, phiAllowed: false};
}

/** A run: observe and bind before the first request, gate every write on the answers so far, observe again at the end. */
export async function beginAcceptanceSession({reader, transport, plan, pair = REVIEWED_SOURCE_PAIR, artifact, deploymentClaim,
  target = PROGRAM_TARGET, now} = {}) {
  const fail = (...codes) => {throw new AcceptanceRefusedError(codes);};
  if (typeof transport?.send !== 'function' || typeof transport.records !== 'function') fail('transport_required');
  const ledger = createWriteLedger(plan);
  const before = await observeProgramTarget(reader, {target, now});
  const binding = evaluateTargetBinding({observation: before, pair, artifact, deploymentClaim, target});
  if (binding.refusals.length) throw new AcceptanceRefusedError(binding.refusals, targetBindingReport(binding, {pair, target}));
  const tokens = new Map(), identities = new Map(), planned = new Map(ledger.plan.map(p => [p.step, p]));
  const send = async (role, path, body) => {
    if (!tokens.has(role)) fail('identity_not_observed');
    return transport.send({role, token: tokens.get(role), path, body});
  };
  const gate = step => {
    const p = planned.get(step);
    if (!p) fail(`step_unplanned:${step}`);
    if (PURCHASE_KINDS.has(p.kind)) fail(`purchase_simulation_refused:${step}`);
    const seen = transport.records();
    if (seen.some(r => r.execution === 'production')) fail('execution_not_qualification');
    if (!seen.some(r => r.execution === 'qualification')) fail('execution_unobserved');
    return p;
  };
  const expect = (record, status) => {if (record.status !== status) fail(`unexpected_status:${record.status}`); return record;};
  return Object.freeze({
    before, binding, ledger,
    identity(role, token) {
      if (!(role in ROLE_POOL)) fail('identity_role_refused');
      const identity = observeIdentityToken(role, token), codes = identityRefusals(identity, target);
      if (codes.length) fail(...codes);
      tokens.set(role, token); identities.set(role, identity);
      return identity;
    },
    read: async (role, path, body, status) => expect(await send(role, path, body), status),
    async write(step, role, path, body, status) {gate(step); return expect(await send(role, path, body), status);},
    async probe(step, role, path, body, refusalStatuses = [403]) {
      if (gate(step).requirement !== 'must_refuse') fail(`step_not_a_probe:${step}`);
      const record = await send(role, path, body);
      if (!refusalStatuses.includes(record.status)) fail(`refusal_not_observed:${step}`);
      ledger.refused(step, record);
      return record;
    },
    created: (step, record) => ledger.created(step, record),
    reused: (step, record, reason) => ledger.reused(step, record, reason),
    skipped: (step, reason) => ledger.skipped(step, reason),
    responses: () => transport.records(),
    async finish({evidence = []} = {}) {
      const after = await observeProgramTarget(reader, {target, now});
      return evaluateHostedProgramAcceptance({before, after, pair, artifact, deploymentClaim, target,
        identities: [...identities.values()], responses: transport.records(), ledger, evidence});
    },
  });
}

/** The program assignment journey. Creation is what this run observed: a replayed assignment is `reused`, and the
 * acceptance it then cannot perform is `skipped`; both are refused under this plan rather than reported as done. */
export const PROGRAM_ASSIGNMENT_PLAN = Object.freeze([
  Object.freeze({step: 'program_assignment', kind: 'assignment', requirement: 'must_create'}),
  Object.freeze({step: 'assignment_acceptance', kind: 'acceptance', requirement: 'must_create'}),
  Object.freeze({step: 'foreign_owner_read', kind: 'isolation', requirement: 'must_refuse'}),
  Object.freeze({step: 'held_supplement_completion', kind: 'hold', requirement: 'must_refuse'}),
]);
export async function runProgramAssignmentJourney(session, {connectionId, programVersionId, heldItemId}) {
  const consumer = '/clinical-core/consumer/programs', workforce = '/clinical-core/workforce/programs';
  const shape = ok => {if (!ok) throw new AcceptanceRefusedError(['response_shape']);};
  const list = await session.read('consumer', consumer, {action: 'list'}, 200);
  shape(Array.isArray(list.body?.data?.assignments));
  const assigned = await session.write('program_assignment', 'workforce', workforce, {action: 'assign', connectionId, programVersionId}, 200);
  const enrollmentId = assigned.body?.data?.enrollmentId, sourceDigest = assigned.body?.data?.sourceDigest;
  shape(typeof enrollmentId === 'string' && typeof sourceDigest === 'string');
  if (classifyWrite(assigned) === 'reused') session.reused('program_assignment', assigned, 'server_reported_duplicate');
  else session.created('program_assignment', assigned);
  const offered = await session.read('consumer', consumer, {action: 'read', enrollmentId}, 200);
  const assignment = offered.body?.data?.assignment;
  shape(assignment && typeof assignment.state === 'string');
  let revision = assignment.revision;
  if (assignment.state === 'offered') {
    const accepted = await session.write('assignment_acceptance', 'consumer', consumer, {action: 'accept', enrollmentId, sourceDigest,
      expectedRevision: revision, planRevision: offered.body.data.review?.planRevision}, 200);
    shape(accepted.body?.data?.state === 'active');
    revision = accepted.body.data.revision;
    if (classifyWrite(accepted) === 'reused') session.reused('assignment_acceptance', accepted, 'server_reported_replay');
    else session.created('assignment_acceptance', accepted);
  } else session.skipped('assignment_acceptance', `assignment_already_${assignment.state}`);
  await session.probe('foreign_owner_read', 'foreignConsumer', consumer, {action: 'read', enrollmentId});
  await session.probe('held_supplement_completion', 'consumer', consumer, {action: 'complete', enrollmentId, sourceDigest,
    expectedRevision: revision, itemId: heldItemId});
  return session.finish();
}

export function parseArguments(argv) {
  const fail = () => {throw new AcceptanceRefusedError(['arguments']);};
  if (!Array.isArray(argv) || argv.length < 1 || argv.length > 3 || argv[0] !== '--observe-read-only') fail();
  const options = {};
  for (const arg of argv.slice(1)) {
    const match = /^--(reviewed-artifact|deployment-claim)=(.+)$/.exec(arg);
    if (!match || !isAbsolute(match[2]) || match[1] in options) fail();
    options[match[1]] = match[2];
  }
  return {artifact: options['reviewed-artifact'], claim: options['deployment-claim']};
}
function readBounded(file, limit) {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.size > limit) throw new AcceptanceRefusedError(['input_file_refused']);
  return readFileSync(file);
}
async function main() {
  const args = parseArguments(process.argv.slice(2));
  const artifact = args.artifact ? readBounded(args.artifact, 16 * 1024 * 1024) : undefined;
  let claim;
  if (args.claim) {
    try {claim = JSON.parse(readBounded(args.claim, 1024 * 1024).toString('utf8'));}
    catch (error) {throw error instanceof AcceptanceRefusedError ? error : new AcceptanceRefusedError(['deployment_claim_unreadable']);}
  }
  const observation = await observeProgramTarget(createAwsCliReader());
  const binding = evaluateTargetBinding({observation, artifact, deploymentClaim: claim});
  console.log(JSON.stringify(targetBindingReport(binding)));
  if (binding.refusals.length) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(error instanceof AcceptanceRefusedError || error instanceof HostedObservationError ? error.message
      : 'hosted_program_acceptance_refused:observation_failed');
    process.exitCode = 1;
  });
}
