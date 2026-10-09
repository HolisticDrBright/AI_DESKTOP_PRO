import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';
import {readFileSync} from 'node:fs';

/**
 * Direct tests for the database's own copy of the program content contract.
 *
 * The first version of `program_content_valid` accepted a phase with `days` or `items`
 * simply removed. The reason is worth stating because it generalises: a long boolean of
 * `jsonb_typeof(x) <> 'number'` comparisons evaluates to NULL when the key is absent,
 * NULL is not true, and an `if` on it does not fire. The HTTP contract caught it, so
 * nothing reached a patient — but the database contract is the one that has to hold for
 * every future caller, and it did not.
 *
 * So these assertions go at the SQL function, not through the adapter, and they cover
 * three different ways a field can be wrong: absent, JSON null, and the wrong type.
 */
let db:PGlite;

const product=()=>({id:'product-fictional-1',ingredientKeys:['fictional-mineral'],dose:'100 mg',purchaseUrl:null});
const lesson=()=>({id:'lesson-a',title:'Fictional lesson',kind:'lesson',instructions:'Read it.',released:true});
const supplement=()=>({id:'supp-1',title:'Fictional supplement step',kind:'supplement',
 instructions:'Fictional instruction.',released:true,product:product()});
const phase=(items:unknown[]=[lesson()])=>({id:'phase-1',title:'Phase one',days:1,transition:'scheduled',items});
const valid=(items?:unknown[])=>[phase(items)];

async function contentValid(content:unknown):Promise<boolean|null>{
 const result=await db.query<{ok:boolean|null}>('select clinical_private.program_content_valid($1::jsonb) as ok',[JSON.stringify(content)]);
 return result.rows[0]?.ok ?? null;
}
async function consumerContent(versionContent:unknown):Promise<unknown>{
 const result=await db.query<{program:unknown}>('select clinical_private.program_consumer_content($1::jsonb) as program',[JSON.stringify(versionContent)]);
 return result.rows[0]?.program ?? null;
}
/** The same object with one key removed, however deep. */
function without<T extends Record<string,unknown>>(source:T,key:string):Record<string,unknown>{
 const copy={...source} as Record<string,unknown>;delete copy[key];return copy;
}

beforeAll(async()=>{
 db=new PGlite({extensions:{pgcrypto}});
 const manifest=JSON.parse(readFileSync('infra/aws-clinical-core/migrations/manifest.json','utf8')) as {migrations:{file:string}[]};
 for(const {file} of manifest.migrations)await db.exec(readFileSync('infra/aws-clinical-core/migrations/'+file,'utf8'));
},60000);
afterAll(async()=>{await db?.close();});

describe('the database copy of the program content contract',()=>{
 it('accepts the valid shape, so the negatives below mean something',async()=>{
  expect(await contentValid(valid())).toBe(true);
  expect(await contentValid(valid([lesson(),supplement()]))).toBe(true);
 });

 it('rejects a phase with any required field absent',async()=>{
  for(const key of ['id','title','days','transition','items']){
   expect(await contentValid([without(phase(),key)]),key).toBe(false);
  }
 });

 it('rejects a phase with any required field explicitly null',async()=>{
  for(const key of ['id','title','days','transition','items']){
   expect(await contentValid([{...phase(),[key]:null}]),key).toBe(false);
  }
 });

 it('rejects a phase field of the wrong JSON type',async()=>{
  const wrong:Array<[string,unknown]>=[['id',7],['title',{}],['days','1'],['days',[1]],
   ['transition',true],['items',{}],['items','none']];
  for(const [key,value] of wrong){
   expect(await contentValid([{...phase(),[key]:value}]),`${key}=${JSON.stringify(value)}`).toBe(false);
  }
 });

 it('rejects a non-integer, zero, negative or oversized day count',async()=>{
  for(const days of [0,-1,1.5,366])expect(await contentValid([{...phase(),days}]),String(days)).toBe(false);
 });

 it('rejects an item with any required field absent, null or of the wrong type',async()=>{
  for(const key of ['id','title','kind','instructions','released']){
   expect(await contentValid([phase([without(lesson(),key)])]),`absent ${key}`).toBe(false);
   expect(await contentValid([phase([{...lesson(),[key]:null}])]),`null ${key}`).toBe(false);
  }
  for(const [key,value] of [['id',1],['title',[]],['kind','mystery'],['instructions',3],['released','yes']] as Array<[string,unknown]>){
   expect(await contentValid([phase([{...lesson(),[key]:value}])]),`${key}=${JSON.stringify(value)}`).toBe(false);
  }
 });

 it('rejects a supplement whose product is absent, null or incomplete',async()=>{
  expect(await contentValid([phase([without(supplement(),'product')])])).toBe(false);
  expect(await contentValid([phase([{...supplement(),product:null}])])).toBe(false);
  for(const key of ['id','ingredientKeys','dose','purchaseUrl']){
   expect(await contentValid([phase([{...supplement(),product:without(product(),key)}])]),`absent ${key}`).toBe(false);
  }
  for(const [key,value] of [['id',null],['dose',null],['ingredientKeys',null],['ingredientKeys',[]],
   ['ingredientKeys',['ok',null]],['ingredientKeys',['same','same']],['dose',''],
   ['purchaseUrl','http://insecure.example.com'],['purchaseUrl','not a url']] as Array<[string,unknown]>){
   expect(await contentValid([phase([{...supplement(),product:{...product(),[key]:value}}])]),`${key}=${JSON.stringify(value)}`).toBe(false);
  }
 });

 it('keeps a product off anything that is not a supplement',async()=>{
  expect(await contentValid([phase([{...lesson(),product:product()}])])).toBe(false);
  for(const kind of ['diet','habit']){
   expect(await contentValid([phase([{...lesson(),kind,product:product()}])]),kind).toBe(false);
   expect(await contentValid([phase([{...lesson(),kind}])]),kind).toBe(true);
  }
 });

 it('rejects unreviewed extra keys at every level',async()=>{
  expect(await contentValid([{...phase(),surprise:1}])).toBe(false);
  expect(await contentValid([phase([{...lesson(),surprise:1}])])).toBe(false);
  expect(await contentValid([phase([{...supplement(),product:{...product(),surprise:1}}])])).toBe(false);
 });

 it('rejects duplicate phase and item identifiers, and an empty or oversized program',async()=>{
  expect(await contentValid([phase(),phase()])).toBe(false);
  expect(await contentValid([phase([lesson(),lesson()])])).toBe(false);
  expect(await contentValid([])).toBe(false);
  expect(await contentValid(null)).toBe(false);
  expect(await contentValid({})).toBe(false);
  expect(await contentValid(Array.from({length:53},(_unused,index)=>({...phase(),id:`phase-${index}`})))).toBe(false);
 });
});

describe('what a published version has actually approved for patients',()=>{
 const approved=(over:Record<string,unknown>={})=>({consumerProgram:{title:'Fictional guide',phases:valid(),...over}});

 it('returns the compiled program when the version carries one',async()=>{
  expect(await consumerContent(approved())).toEqual({title:'Fictional guide',phases:valid()});
 });

 it('returns nothing when the version approved nothing patient-facing',async()=>{
  for(const content of [
   {}, // published, but empty — the exact shape the audit exploited
   null,
   [],
   {consumerProgram:null},
   {consumerProgram:[]},
   {consumerProgram:{title:'Fictional guide'}},
   {consumerProgram:{phases:valid()}},
   {consumerProgram:{title:'',phases:valid()}},
   {consumerProgram:{title:null,phases:valid()}},
   {consumerProgram:{title:'Fictional guide',phases:[]}},
   {consumerProgram:{title:'Fictional guide',phases:valid(),surprise:1}},
   {consumerProgram:{title:'Fictional guide',phases:[without(phase(),'days')]}},
  ])expect(await consumerContent(content),JSON.stringify(content)).toBeNull();
 });

 it('trims the approved title rather than storing what happened to be typed',async()=>{
  expect(await consumerContent(approved({title:'  Fictional guide  '}))).toEqual({title:'Fictional guide',phases:valid()});
 });

 it('reads only the consumer program, ignoring the rest of an authoring document',async()=>{
  const withAuthoring={authorNotes:'internal',reviewHistory:[{at:'2026-09-01'}],...approved()};
  expect(await consumerContent(withAuthoring)).toEqual({title:'Fictional guide',phases:valid()});
 });
});
