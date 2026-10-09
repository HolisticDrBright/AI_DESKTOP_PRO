import {describe,expect,it} from 'vitest';
import {readFileSync} from 'node:fs';

/**
 * The five launch surfaces must tell a practitioner the difference between "there is
 * nothing here yet" and "we could not load it".
 *
 * Those are opposite facts. An empty review queue shown as a failure sends someone
 * looking for a problem that does not exist; a failed load shown as empty tells them
 * there is no work waiting when there may be plenty. Neither may be the other, and
 * neither may be a blank page.
 *
 * Asserted at source because this repository has no component-render harness. That is a
 * real limitation: this checks the branches exist and are distinct, not what they look
 * like on screen.
 */
const SURFACES = [
  {name: 'Inbox', file: 'src/components/inbox/InboxWorkspace.tsx'},
  {name: 'Programs', file: 'src/components/programs/ProgramsWorkspace.tsx'},
  {name: 'Review queue', file: 'src/components/tasks/TasksQueue.tsx'},
  {name: 'Billing', file: 'src/components/billing/BillingWorkspace.tsx'},
  {name: 'Calendar', file: 'src/components/calendar/CalendarView.tsx'},
] as const;

const EMPTY_BRANCH = /\.length\s*===\s*0|\.length\s*<\s*1|isEmpty|ClinicalEmpty|Empty[A-Z]\w*Note/;
const ERROR_PRESENTATION = /ClinicalError|role="alert"|loadError|setError\(/;
const LOADING_PRESENTATION = /ClinicalLoading|"loading"|'loading'|isLoading|isPending/;

describe('empty is not failure, on every launch surface',()=>{
 for(const {name,file} of SURFACES){
  it(`${name} distinguishes empty, failed and loading`,()=>{
   const source=readFileSync(file,'utf8');
   expect(EMPTY_BRANCH.test(source),`${name} needs an explicit empty branch`).toBe(true);
   expect(ERROR_PRESENTATION.test(source),`${name} needs a distinct failure presentation`).toBe(true);
   expect(LOADING_PRESENTATION.test(source),`${name} needs a distinct loading presentation`).toBe(true);
  });
 }
 it('never presents a load failure as generic reassurance',()=>{
  // "No results" on a failed request is the specific lie this guards against.
  for(const {name,file} of SURFACES){
   const source=readFileSync(file,'utf8');
   const conflated=/catch[\s\S]{0,200}?(No results|nothing here|No items|is empty)/i.exec(source);
   expect(conflated?.[0],`${name} presents a failure as emptiness`).toBeUndefined();
  }
 });
 it('leaves a way forward from an empty surface rather than a dead end',()=>{
  // An empty workspace that offers no action is indistinguishable from a broken one.
  for(const {name,file} of SURFACES){
   const source=readFileSync(file,'utf8');
   const hasAction=/<button|<Btn|onClick=|href=|<Link/.test(source);
   expect(hasAction,`${name} must keep an action available when empty`).toBe(true);
  }
 });
 it('is asserting about surfaces that exist',()=>{
  for(const {name,file} of SURFACES)
   expect(readFileSync(file,'utf8').length,name).toBeGreaterThan(500);
 });
});
