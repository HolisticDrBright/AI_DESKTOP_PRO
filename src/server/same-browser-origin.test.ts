import {describe,expect,it} from 'vitest';
import {sameBrowserOrigin} from './same-browser-origin';

const HOST='penrnyupn3.us-east-2.awsapprunner.com';
// The hosted deployment's shape: the browser's public authority in the headers, the
// internal listener in the URL. A check that compares Origin to the URL fails here.
const hosted=(headers:Record<string,string>={},url='http://0.0.0.0:3000/api/live/x')=>
 new Request(url,{method:'POST',headers:{host:HOST,origin:'https://'+HOST,'sec-fetch-site':'same-origin',...headers}});

describe('same-origin validation behind a TLS-terminating proxy',()=>{
 it('accepts the browser public origin without trusting the internal listener URL',()=>{
  expect(sameBrowserOrigin(hosted())).toBe(true);
  // Absent sec-fetch-site (older browsers, non-browser clients) is not by itself a refusal.
  expect(sameBrowserOrigin(new Request('http://0.0.0.0:3000/api/live/x',
   {method:'POST',headers:{host:HOST,origin:'https://'+HOST}}))).toBe(true);
 });
 it('never lets a forwarding header decide',()=>{
  expect(sameBrowserOrigin(hosted({'x-forwarded-host':'evil.example',origin:'https://evil.example'}))).toBe(false);
  // A forged forwarded host cannot rescue a mismatched Origin, nor break a matching one.
  expect(sameBrowserOrigin(hosted({'x-forwarded-host':'evil.example'}))).toBe(true);
  expect(sameBrowserOrigin(hosted({'x-forwarded-proto':'http'}))).toBe(true);
 });
 it('refuses a cross-site request, a missing header and an Origin that is not a bare origin',()=>{
  const cases:Record<string,string>[]=[{origin:'https://evil.example'},{origin:''},{host:''},{origin:'http://'+HOST},
   {origin:'https://'+HOST+'/path'},{origin:'https://user:pass@'+HOST},{origin:'null'},{origin:'not a url'},
   {'sec-fetch-site':'cross-site'},{'sec-fetch-site':'same-site'},{'sec-fetch-site':'none'}];
  for(const headers of cases)expect(sameBrowserOrigin(hosted(headers)),JSON.stringify(headers)).toBe(false);
 });
 it('preserves loopback-only HTTP development, and only when the listener agrees',()=>{
  expect(sameBrowserOrigin(new Request('http://localhost:3164/api/live/x',{method:'POST',
   headers:{host:'localhost:3164',origin:'http://localhost:3164','sec-fetch-site':'same-origin'}}))).toBe(true);
  // Plain HTTP on a non-loopback host, or on a host the listener does not serve, is refused.
  expect(sameBrowserOrigin(new Request('http://localhost:3164/api/live/x',{method:'POST',
   headers:{host:'internal.example',origin:'http://internal.example','sec-fetch-site':'same-origin'}}))).toBe(false);
  expect(sameBrowserOrigin(new Request('http://localhost:9999/api/live/x',{method:'POST',
   headers:{host:'localhost:3164',origin:'http://localhost:3164','sec-fetch-site':'same-origin'}}))).toBe(false);
 });
 it('accepts Next loopback listener aliases only on the identical port',()=>{
  for(const [originHost,listenerHost] of [['127.0.0.1','localhost'],['localhost','127.0.0.1']]) {
   expect(sameBrowserOrigin(new Request(`http://${listenerHost}:3100/api/public/consult`,{method:'POST',
    headers:{host:`${originHost}:3100`,origin:`http://${originHost}:3100`,'sec-fetch-site':'same-origin'}}))).toBe(true);
  }
 });
 it('never accepts a loopback alias across ports, a non-loopback listener, or a mismatched browser host',()=>{
  for(const url of ['http://localhost:3101/api/x','http://internal.example:3100/api/x']) {
   expect(sameBrowserOrigin(new Request(url,{method:'POST',headers:{host:'127.0.0.1:3100',origin:'http://127.0.0.1:3100','sec-fetch-site':'same-origin'}}))).toBe(false);
  }
  expect(sameBrowserOrigin(new Request('http://localhost:3100/api/x',{method:'POST',headers:{host:'localhost:3100',origin:'http://127.0.0.1:3100','sec-fetch-site':'same-origin'}}))).toBe(false);
 });
});
