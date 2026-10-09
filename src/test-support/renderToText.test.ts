import {createElement as h,type ReactElement} from 'react';
import {describe,expect,it} from 'vitest';
import {renderToText,renderToMarkup,renderedTestIds} from './renderToText';

/** The harness itself, so a test that uses it is not resting on an untested reader. */
function Sample({show}:{show:boolean}):ReactElement{
 return h('section',{'data-testid':'sample'},
  h('h2',null,'A heading'),
  show
   ?h('p',{'data-testid':'shown'},'The branch that renders')
   :h('p',{'data-testid':'hidden'},'The other branch'),
  h('style',null,'.a{color:red}'));
}

describe('the render harness',()=>{
 it('reads back the text a component actually produced',()=>{
  expect(renderToText(h(Sample,{show:true}))).toBe('A heading The branch that renders');
  expect(renderToText(h(Sample,{show:false}))).toBe('A heading The other branch');
 });

 it('drops style and script contents rather than reading them as prose',()=>{
  expect(renderToText(h(Sample,{show:true}))).not.toContain('color:red');
 });

 it('decodes the entities a renderer introduces, so an apostrophe compares as one',()=>{
  expect(renderToText(h('p',null,"it's & <that>"))).toBe("it's & <that>");
 });

 it('reports only the test ids that were really rendered',()=>{
  expect(renderedTestIds(h(Sample,{show:true}))).toEqual(['sample','shown']);
  expect(renderedTestIds(h(Sample,{show:false}))).toEqual(['hidden','sample']);
 });

 it('exposes the markup for attribute assertions',()=>{
  expect(renderToMarkup(h(Sample,{show:true}))).toContain('data-testid="shown"');
 });
});
