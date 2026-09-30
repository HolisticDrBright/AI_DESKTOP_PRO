import {describe,expect,it} from 'vitest';
import {readFileSync} from 'node:fs';

/**
 * The panel is asserted at source level because this repository has no component
 * render harness. What matters here is not layout: it is that the panel authors no
 * clinical content, states plainly what sharing does and does not do, and treats a
 * refused revision as the server deciding rather than something to retry.
 */
const source=readFileSync('src/components/programs/AppProgramAssignmentsPanel.tsx','utf8');
const page=readFileSync('src/app/inbox/page.tsx','utf8');

describe('the practitioner assignment panel',()=>{
 it('is reachable from a real screen',()=>{
  expect(page).toContain('AppProgramAssignmentsPanel');
  expect(page).toContain("from '@/components/programs/AppProgramAssignmentsPanel'");
 });
 it('reaches the service only through the workforce proxy, never a token in the browser',()=>{
  expect(source).toContain("fetch('/api/live/program-assignments'");
  expect(source).toContain("credentials:'same-origin'");
  expect(source).toContain("cache:'no-store'");
  // The cookie session is exchanged server-side; nothing here holds a bearer token.
  expect(source).not.toContain('authorization');
  expect(source).not.toContain('Bearer');
  expect(source).not.toMatch(/CLINICAL_AWS|process\.env/);
 });
 it('only sends workforce actions and never a consumer one',()=>{
  for(const action of ['assign','status','release','connections'])expect(source,action).toContain(`action:'${action}'`);
  for(const action of ['accept','complete','check_in','advance','pause','resume','withdraw'])
   expect(source,action).not.toContain(`action:'${action}'`);
 });
 it('says what sharing does not do, in the patient’s terms',()=>{
  expect(source).toContain('does not enrol them, charge');
  expect(source).toContain('the patient decides whether to add it');
  expect(source).toContain('their plan is unchanged until they do');
  // The supplement consequence is stated where a practitioner would act on it.
  expect(source).toContain('Supplement steps are held for review');
  expect(source).toContain('a phase containing a held step will not advance');
 });
 it('never claims a second share happened when the server said duplicate',()=>{
  expect(source).toContain('Nothing changed and it was not shared twice');
 });
 it('reports a refusal as a decision, not as something to retry',()=>{
  expect(source).toContain('response.status===409');
  expect(source).toContain('Nothing was assigned');
  expect(source).toContain('Nothing was changed');
 });
 it('clears on access loss and on the tab being hidden',()=>{
  expect(source).toContain('onWorkforceSessionChange');
  expect(source).toContain('visibilitychange');
  expect(source).toContain('response.status===401||response.status===403');
 });
 it('refuses to send phases it could not parse',()=>{
  expect(source).toContain('not valid JSON, so nothing was sent');
 });
 it('authors no clinical content of its own',()=>{
  // No default phases, no example markers, no generated instructions.
  for(const forbidden of ['ferritin','vitamin','magnesium','defaultPhases','sampleProgram','instructions:'])
   expect(source.toLowerCase(),forbidden).not.toContain(forbidden.toLowerCase());
 });
});
