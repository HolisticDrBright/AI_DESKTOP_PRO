import {describe,expect,it} from 'vitest';
import {readFileSync} from 'node:fs';

/**
 * These source assertions complement the actual Chromium panel lifecycle suite.
 * What matters here is not layout: it is that the panel authors no
 * clinical content, states plainly what sharing does and does not do, and treats a
 * refused revision as the server deciding rather than something to retry.
 */
const source=readFileSync('src/components/programs/AppProgramAssignmentsPanel.tsx','utf8').replace(/\r\n?/g,'\n');
const page=readFileSync('src/app/inbox/page.tsx','utf8').replace(/\r\n?/g,'\n');

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
  expect(source).not.toContain('Nothing was changed');
  expect(source).toContain('We could not confirm whether the change was saved');
  expect(source).toContain('No automatic retry was made');
 });
 it('clears on access loss and on the tab being hidden',()=>{
  expect(source).toContain('onWorkforceSessionChange');
  expect(source).toContain('visibilitychange');
  expect(source).toContain('response.status===401||response.status===403');
 });
 it('sends no content at all, so there is nothing for it to parse',()=>{
  // The panel used to take a paste of phases JSON and a title. The server trusted both,
  // which is how a published-but-empty version could deliver unreviewed content. Neither
  // the field nor the request shape exists now.
  for(const forbidden of ['JSON.parse','phasesText','setTitle','Phases from that published version',
   'Published program version id','title:','phases:'])
   expect(source,forbidden).not.toContain(forbidden);
 });
 it('picks a published version and previews what the server compiled from it',()=>{
  for(const required of ["action:'programs'","action:'preview'","program-source-picker","program-preview",
   'Select a published program','nothing approved for patients in this version',
   'it comes from the\n     published version, not from anything typed here'])
   expect(source,required).toContain(required);
 });
 it('will not offer to share before a preview has come back',()=>{
  expect(source).toContain('disabled={busy||!programVersionId.trim()||!preview}');
 });
 it('says that a held step blocks its phase, on the preview itself',()=>{
  expect(source).toContain('will not be able to pass a phase containing one');
 });
 it('authors no clinical content of its own',()=>{
  // No default phases, no example markers, no generated instructions.
  for(const forbidden of ['ferritin','vitamin','magnesium','defaultPhases','sampleProgram','instructions:'])
   expect(source.toLowerCase(),forbidden).not.toContain(forbidden.toLowerCase());
 });
});
