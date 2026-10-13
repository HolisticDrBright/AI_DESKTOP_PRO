import {describe,it,expect} from 'vitest';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {learnerMediaCapabilityShapeValid,learnerMediaRequest,lessonMediaReferences} from './programLearnerMedia';

/**
 * The learner media contract is a byte-for-byte source the consumer app mirrors as expo/contracts/programLearnerMedia.ts
 * (LF-normalised SHA-256 below, pinned on both sides). A change on one side without the other fails here.
 */
const MIRROR_SHA256='8d2c9f62e1bec110cd666d9bcae86a786b58a24d0fabd11ae39c89b6b89a5f99';
describe('the mirrored learner media contract',()=>{
 it('is the exact text the consumer app mirrors',()=>{
  expect(createHash('sha256').update(readFileSync('src/contracts/programLearnerMedia.ts','utf8').replace(/\r\n/g,'\n')).digest('hex')).toBe(MIRROR_SHA256);
 });
 it('names no person, clinic, key or address in a request',()=>{
  const base={contractVersion:'program-learner-media/1',entitlementId:'11111111-1111-4111-8111-111111111111',curriculum:{versionId:'66666666-6666-4666-8666-666666666666',version:2,sourceDigest:'a'.repeat(64)},
   lesson:{phaseId:'phase-1',itemId:'lesson-a'},slot:0,expected:{artifactId:'77777777-7777-4777-8777-777777777777',version:3,sha256:'b'.repeat(64)}};
  expect(learnerMediaRequest.safeParse(base).success).toBe(true);
  for(const extra of [{personId:'x'},{organizationId:'x'},{objectKey:'x'},{url:'https://x.example/'}])expect(learnerMediaRequest.safeParse({...base,...extra}).success).toBe(false);
 });
 it('admits only an exact-version, short-lived capability on the regional bucket host',()=>{
  const good=`https://alp-lessons.s3.us-east-2.amazonaws.com/program-media/a/b.mp4?versionId=v1&X-Amz-Expires=300&X-Amz-Signature=${'c'.repeat(64)}`;
  expect(learnerMediaCapabilityShapeValid(good)).toBe(true);
  for(const bad of [good.replace('https:','http:'),good.replace('?versionId=v1&','?'),good.replace('versionId=v1','versionId=null'),good.replace('X-Amz-Expires=300','X-Amz-Expires=301'),
   good.replace('alp-lessons.s3.us-east-2','alp-lessons.s3.eu-west-1'),good.replace('/program-media/','/other/'),good+'#frag',good+'&versionId=v2'])expect(learnerMediaCapabilityShapeValid(bad),bad).toBe(false);
 });
 it('reads a lesson\'s references only when the lesson is found exactly once and its references parse',()=>{
  expect(lessonMediaReferences([{id:'p',items:[{id:'l'}]}],{phaseId:'p',itemId:'l'})).toEqual([]);
  expect(lessonMediaReferences([{id:'p',items:[{id:'l'},{id:'l'}]}],{phaseId:'p',itemId:'l'})).toBeNull();
  expect(lessonMediaReferences([{id:'p',items:[{id:'l',nativeMedia:[{url:'https://x.example/'}]}]}],{phaseId:'p',itemId:'l'})).toBeNull();
  expect(lessonMediaReferences('not phases',{phaseId:'p',itemId:'l'})).toBeNull();
 });
});
