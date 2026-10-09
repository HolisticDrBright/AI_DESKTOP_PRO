import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {load} from 'js-yaml';
const workflow=load(readFileSync(new URL('../.github/workflows/ci.yml',import.meta.url),'utf8'));
const installs=w=>Object.entries(w.jobs).flatMap(([job,value])=>value.steps
 .filter(step=>typeof step.run==='string'&&step.run.includes('playwright install')).map(step=>({job,step})));
function verify(w){
 const found=installs(w);assert.equal(found.length,7);
 for(const {step} of found){
  assert.equal(step.run,'npx playwright install --with-deps chromium');
  assert.equal(step['timeout-minutes'],10);
  assert.equal(step['continue-on-error'],undefined);
  assert.ok(step.if===undefined||step.if==="steps.gate.outputs.run == 'true'");
 }
 assert.equal(found.filter(v=>v.step.if!==undefined).length,1);
 assert.equal(w.jobs['e2e-live-fixture'].strategy['fail-fast'],false);
 assert.deepEqual(w.jobs['e2e-live-fixture'].strategy.matrix.shard,[1,2,3]);
}
test('all seven browser installs have a ten-minute dependency limit with unchanged command and existing deployment gate',()=>verify(workflow));
test('missing limits, hidden failures, skipped new jobs, removed installs or shell success substitutions are refused',()=>{
 for(const mutate of [w=>delete installs(w)[0].step['timeout-minutes'],w=>installs(w)[0].step['timeout-minutes']=360,
  w=>installs(w)[0].step['continue-on-error']=true,w=>installs(w)[0].step.if='false',
  w=>installs(w)[0].step.run+=' || true',w=>installs(w)[0].step.run='echo no download',
  w=>w.jobs['e2e-live-fixture'].strategy.matrix.shard=[1]]){
  const copy=structuredClone(workflow);mutate(copy);assert.throws(()=>verify(copy));
 }
});
