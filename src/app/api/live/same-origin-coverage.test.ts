import {describe,expect,it} from 'vitest';
import {readFileSync,readdirSync,statSync} from 'node:fs';
import {join} from 'node:path';

/**
 * The messaging route's reverse-proxy origin fix did not propagate: seven other
 * mutating live routes still compared `Origin` against the INTERNAL request URL,
 * which behind App Runner's TLS termination refuses every legitimate same-origin
 * browser request — so the defence they were reaching for was not actually running.
 *
 * These assertions keep that from happening again. They do not claim every live
 * route performs an origin check: cross-site mutation is already refused by the
 * session cookie's SameSite policy, which is pinned below. What they require is
 * that a route which DOES check has exactly one implementation to check with.
 */
function routes(directory:string):string[]{
 const out:string[]=[];
 for(const entry of readdirSync(directory)){
  const full=join(directory,entry);
  if(statSync(full).isDirectory())out.push(...routes(full));
  else if(entry==='route.ts')out.push(full);
 }
 return out;
}
const LIVE=routes('src/app/api/live');
const MUTATES=/export\s+(async\s+)?function\s+(POST|PUT|PATCH|DELETE)/;
// The shapes that were wrong: comparing the browser's Origin to the internal listener.
const REIMPLEMENTED=[/headers\.get\(['"]origin['"]\)\s*!==\s*new URL\(request\.url\)\.origin/,
 /headers\.get\(['"]origin['"]\)\s*!==\s*(req|request)\.nextUrl\.origin/,
 /headers\.get\(['"]origin['"]\)\s*!==\s*url\.origin/];

describe('same-origin validation has one implementation',()=>{
 it('finds the live surface it is asserting about',()=>{
  expect(LIVE.length).toBeGreaterThan(150);
  expect(LIVE.filter(file=>MUTATES.test(readFileSync(file,'utf8'))).length).toBeGreaterThan(150);
 });
 it('no route compares the browser origin against its own internal URL',()=>{
  const offenders=LIVE.filter(file=>{
   const source=readFileSync(file,'utf8');
   return REIMPLEMENTED.some(pattern=>pattern.test(source));
  });
  expect(offenders).toEqual([]);
 });
 it('every route that checks the origin at all does so through the shared helper',()=>{
  const offenders=LIVE.filter(file=>{
   const source=readFileSync(file,'utf8');
   return source.includes('sec-fetch-site')&&!source.includes('sameBrowserOrigin');
  });
  expect(offenders).toEqual([]);
 });
 it('keeps the cookie policy that refuses cross-site mutation for every other route',()=>{
  // This is the defence the unguarded routes actually rely on, so it is pinned here
  // rather than left as an assumption.
  const cookies=readFileSync('src/adapters/auth.server.ts','utf8');
  expect(cookies).toContain('sameSite: "lax" as const');
  expect(cookies).toContain('httpOnly: true');
 });
});
