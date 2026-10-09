import {createElement as h} from 'react';
import {describe,expect,it} from 'vitest';
import {renderToText} from '@/test-support/renderToText';
import {FeedbackProvider} from '@/lib/feedback';
import {InboxWorkspace} from '@/components/inbox/InboxWorkspace';
import {ProgramsWorkspace} from '@/components/programs/ProgramsWorkspace';
import {BillingWorkspace} from '@/components/billing/BillingWorkspace';
import {TasksQueue} from '@/components/tasks/TasksQueue';
import {CalendarView} from '@/components/calendar/CalendarView';

/**
 * The five launch surfaces on first paint, rendered rather than scanned.
 *
 * `launch-surface-empty-states.test.ts` asserts that each surface has three distinct
 * branches. It cannot assert which one renders, because a source scan cannot. That matters
 * for exactly one reason: an empty review queue shown as a failure sends a practitioner
 * looking for a problem that does not exist, and a failed load shown as empty tells them no
 * work is waiting when there may be plenty. The branch that renders first, before any data
 * has arrived, must be neither of those claims.
 *
 * Effects do not run in this harness, so this is the pre-data state and nothing further.
 * The states that follow a load still need a DOM and a testing library.
 */
/** The surfaces run inside the app's providers, so the harness supplies the real ones. */
const inProviders = (element: Parameters<typeof renderToText>[0]) =>
  renderToText(h(FeedbackProvider, null, element));
const SURFACES: Array<[string, () => string]> = [
  ['Inbox', () => inProviders(h(InboxWorkspace, {}))],
  ['Programs', () => inProviders(h(ProgramsWorkspace, {}))],
  ['Billing', () => inProviders(h(BillingWorkspace, {}))],
  ['Review queue', () => inProviders(h(TasksQueue, {}))],
  ['Calendar', () => inProviders(h(CalendarView, {}))],
];

describe('launch surfaces on first paint',()=>{
 it('renders at all, which is the precondition for the rest',()=>{
  for(const [name,render] of SURFACES){
   expect(()=>render(),name).not.toThrow();
  }
 });

 it('says something to a screen reader while it loads, not only to the eye',()=>{
  // The calendar rendered a pulsing placeholder marked aria-hidden and no text at all:
  // "loading" to someone looking at it, silence to someone who is not, and therefore no
  // way to tell loading from empty from broken. Every surface must say it out loud.
  for(const [name,render] of SURFACES){
   const text=render();
   expect(text.length,`${name} rendered no readable text on first paint`).toBeGreaterThan(0);
  }
 });

 it('claims neither emptiness nor failure before any data has arrived',()=>{
  // The words that would be a lie at this moment. A surface may say it is loading, or
  // say nothing; it may not say there is nothing, and it may not say something broke.
  const FALSE_EMPTY=[/\bno results\b/i,/\bnothing (?:to show|here|found)\b/i,/\bempty\b/i,
   /\bno (?:messages|programs|tasks|invoices|appointments) (?:yet|found)\b/i];
  const FALSE_FAILURE=[/\bcouldn'?t load\b/i,/\bfailed to load\b/i,/\bsomething went wrong\b/i,/\btry again\b/i];
  for(const [name,render] of SURFACES){
   const text=render();
   for(const pattern of [...FALSE_EMPTY,...FALSE_FAILURE]){
    expect(text,`${name} said "${pattern}" before loading anything`).not.toMatch(pattern);
   }
  }
 });
});
