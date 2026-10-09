import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspectStack, replacementParameters, candidateBuildspec } from './refresh-production-candidates.mjs';
const old = 'a'.repeat(40), next = 'b'.repeat(40);
function stack() { return { StackStatus: 'UPDATE_COMPLETE', Outputs: [{ OutputKey: 'PhiAllowed', OutputValue: 'false' }, { OutputKey: 'WorkloadMode', OutputValue: 'readiness_only' }], Parameters: [{ ParameterKey: 'SourceVersion', ParameterValue: old }, { ParameterKey: 'ImageTag', ParameterValue: old }, { ParameterKey: 'DeployService', ParameterValue: 'true' }, { ParameterKey: 'ConsumerClientId', ParameterValue: 'existing-client' }] }; }
test('only source and image change; existing service and identity are preserved', () => {
  const params = replacementParameters(stack(), next);
  assert.deepEqual(params.slice(0, 2).map(x => x.ParameterValue), [next, next]);
  assert.deepEqual(params.slice(2), [{ ParameterKey: 'DeployService', UsePreviousValue: true }, { ParameterKey: 'ConsumerClientId', UsePreviousValue: true }]);
});
test('active PHI, public workload mode and concurrent update are refused', () => {
  for (const mutate of [s => s.Outputs[0].OutputValue = 'true', s => s.Outputs[1].OutputValue = 'active', s => s.StackStatus = 'UPDATE_IN_PROGRESS']) {
    const s = stack(); mutate(s); assert.throws(() => inspectStack(s));
  }
});
test('failed build cannot push a candidate and exact commit replaces prior source', () => {
  const result = candidateBuildspec(`Dockerfile.production ${old}\nPHI_ALLOWED=false production_not_activated\n  - docker push repo:${old}\n`, { SourceVersion: old, ImageTag: old }, next);
  assert.ok(!result.includes(old));
  assert.ok(result.includes(`repo:${next}`));
  assert.match(result, /test "\$CODEBUILD_BUILD_SUCCEEDING" = 1\n  - docker push/);
  assert.throws(() => candidateBuildspec('docker push repo', { SourceVersion: old, ImageTag: old }, next));
});
