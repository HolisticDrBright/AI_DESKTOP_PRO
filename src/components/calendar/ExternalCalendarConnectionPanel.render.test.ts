import {createElement as h} from 'react';
import {describe,expect,it} from 'vitest';
import {renderToText,renderedTestIds} from '@/test-support/renderToText';
import {ExternalCalendarConnectionPanel} from './ExternalCalendarConnectionPanel';
import {AppProgramAssignmentsPanel} from '@/components/programs/AppProgramAssignmentsPanel';

/**
 * What these panels actually render on first paint, rather than what their source contains.
 *
 * Effects do not run here, so this is the state a practitioner sees before anything has
 * loaded. That state is worth asserting on its own: it is the one a slow or failed network
 * leaves them looking at, and the one most likely to be wrong because it is the least
 * looked at during development.
 */
describe('the calendar connection panel, rendered',()=>{
 const first=h(ExternalCalendarConnectionPanel,{});

 it('shows the checking state before anything has loaded, and nothing else',()=>{
  const text=renderToText(first);
  expect(text).toContain('Checking your calendar connection');
  // Not "no calendar connected": that is an answer, and it has not been obtained yet.
  expect(text).not.toContain('No calendar is connected');
  expect(text).not.toContain('Connected.');
 });

 it('renders only the loading branch, by test id',()=>{
  expect(renderedTestIds(first)).toEqual(['external-calendar-connection','external-calendar-loading']);
 });

 it('states the read-only promise on first paint, not only once connected',()=>{
  // Someone deciding whether to connect reads this before any state has resolved.
  const text=renderToText(first);
  expect(text).toContain('Read-only');
  expect(text).toContain('never event titles, guests or locations');
 });
});

describe('the program assignments panel, rendered',()=>{
 const first=h(AppProgramAssignmentsPanel,{});

 it('offers the loading actions and asserts nothing about a patient yet',()=>{
  const text=renderToText(first);
  expect(text).toContain('Load / refresh assignments');
  expect(text).toContain('Load linked patients');
  expect(text).toContain('Load published programs');
  // No claim about what has or has not been shared before anything has loaded.
  expect(text).not.toContain('No programs have been shared');
 });

 it('says what sharing does and does not do, before anything is selected',()=>{
  const text=renderToText(first);
  expect(text).toContain('does not enrol them, charge');
  expect(text).toContain('Supplement steps are held for review');
 });

 it('shows no source picker until a patient is chosen',()=>{
  expect(renderedTestIds(first)).not.toContain('program-source-picker');
  expect(renderedTestIds(first)).not.toContain('program-preview');
 });
});
