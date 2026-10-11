import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';

/**
 * The standalone, unregistered admission candidate for program item education fields and the
 * product catalog binding. It runs here against the full synthetic manifest and nowhere else.
 *
 * The first block fixes what the candidate must not change: every artifact that validated
 * before validates after, and the compiled consumer program is byte-identical, so no existing
 * source digest moves. The rest is the admission itself, including every way the new fields
 * can be wrong, and the version detail round-trip the Studio needs.
 */
const CANDIDATE='infra/aws-clinical-core/source-candidates/program-education-catalog-admission.sql';
const PARENTS:Record<string,string>={
 'infra/aws-clinical-core/migrations/20260903200000_synthetic_desktop_programs_inbox.sql':'6ba42349af12e2deb2aa163fbca59ea168bababe4017a098ec88314f31a8b26f',
 'infra/aws-clinical-core/migrations/20260929120000_synthetic_program_assignments.sql':'8d6bcac8dfbe5582e7ee63d5f7ed6a5b4466760195f251d10780f08e3fb4a1d8',
};
const sha=(path:string)=>createHash('sha256').update(readFileSync(path)).digest('hex');
let db:PGlite;
const id=(n:number)=>'30000000-0000-4000-8000-'+String(n).padStart(12,'0');
const org=id(1),clinician=id(2),program=id(3),authored=id(4),bare=id(5);

const product=()=>({id:'product-fictional-1',ingredientKeys:['fictional-mineral'],dose:'100 mg',purchaseUrl:null as string|null});
const lesson=()=>({id:'lesson-a',title:'Fictional lesson',kind:'lesson',instructions:'Read it.',released:true});
const supplement=()=>({id:'supp-1',title:'Fictional supplement step',kind:'supplement',instructions:'Fictional instruction.',released:true,product:product()});
const phase=(items:unknown[]=[lesson()])=>({id:'phase-1',title:'Phase one',days:1,transition:'scheduled',items});
const education=()=>({rationale:'It explains the fictional step in plain words.',authorship:'practitioner_authored',
 sources:[{title:'Fictional approved source',url:'https://education.example.com/fictional'}],
 media:[{kind:'video',url:'https://media.example.com/fictional.mp4',caption:'Fictional clinician video'},{kind:'image',url:'https://media.example.com/fictional.png'}]});
const binding=()=>({stableId:'prd_fictional_magnesium',version:3,target:'synthetic-staging'});
const educated=()=>[phase([{...lesson(),...education()},{...supplement(),...education(),product:{...product(),catalog:binding()}}])];

async function valid(content:unknown):Promise<boolean|null>{
 const r=await db.query<{ok:boolean|null}>('select clinical_private.program_content_valid($1::jsonb) as ok',[JSON.stringify(content)]);
 return r.rows[0]?.ok??null;
}
async function compiled(phases:unknown):Promise<string|null>{
 const r=await db.query<{text:string|null}>('select clinical_private.program_consumer_content($1::jsonb)::text as text',[JSON.stringify({consumerProgram:{title:'Fictional guide',phases}})]);
 return r.rows[0]?.text??null;
}
let before:{valid:boolean|null;compiled:string|null;educatedValid:boolean|null;educatedCompiled:string|null};

beforeAll(async()=>{
 for(const [path,digest] of Object.entries(PARENTS))expect(sha(path),path).toBe(digest);
 const candidate=readFileSync(CANDIDATE,'utf8');
 for(const digest of Object.values(PARENTS))expect(candidate).toContain(digest);
 const manifest=JSON.parse(readFileSync('infra/aws-clinical-core/migrations/manifest.json','utf8')) as {migrations:{file:string}[]};
 expect(manifest.migrations.some(m=>m.file.includes('education'))).toBe(false);
 db=new PGlite({extensions:{pgcrypto}});
 for(const {file} of manifest.migrations)await db.exec(readFileSync('infra/aws-clinical-core/migrations/'+file,'utf8'));
 before={valid:await valid([phase([lesson(),supplement()])]),compiled:await compiled([phase([lesson(),supplement()])]),
  educatedValid:await valid(educated()),educatedCompiled:await compiled(educated())};
 await db.exec(candidate);
 await db.query("insert into clinical_core.organizations(id,synthetic_label) values($1,'Fictional A')",[org]);
 await db.query('insert into clinical_core.persons(id,synthetic_subject_key) values($1,$2)',[clinician,'syn_'+clinician.replaceAll('-','')]);
 await db.query("insert into clinical_core.synthetic_desktop_programs(id,organization_id,name,status,created_by_person_id) values($1,$2,'Fictional program','draft',$3)",[program,org,clinician]);
 await db.query(`insert into clinical_core.synthetic_desktop_program_versions(id,organization_id,program_id,version,status,content,created_by_person_id)
  values($1,$2,$3,1,'draft',$4::jsonb,$5),($6,$2,$3,2,'draft',$7::jsonb,$5)`,
  [authored,org,program,JSON.stringify({title:'Fictional',modules:[],consumerProgram:{title:'Fictional guide',phases:educated()}}),clinician,bare,JSON.stringify({title:'Bare',modules:[]})]);
},90000);
afterAll(async()=>{await db?.close();});

describe('what the candidate must not change',()=>{
 it('the parent refused the education fields and the binding, which is the gap this candidate closes',()=>{
  expect(before.valid).toBe(true);expect(before.educatedValid).toBe(false);expect(before.educatedCompiled).toBeNull();
 });
 it('an artifact without the new fields validates as before and compiles byte-identically, so its digest is unchanged',async()=>{
  expect(await valid([phase([lesson(),supplement()])])).toBe(true);
  expect(await compiled([phase([lesson(),supplement()])])).toBe(before.compiled);
  expect(before.compiled).toContain('"phases"');
 });
 it('still refuses every shape the parent refused',async()=>{
  expect(await valid([{...phase(),surprise:1}])).toBe(false);
  expect(await valid([phase([{...lesson(),product:product()}])])).toBe(false);
  expect(await valid([phase([{...supplement(),product:{...product(),purchaseUrl:'http://insecure.example.com'}}])])).toBe(false);
  expect(await valid([phase([lesson(),lesson()])])).toBe(false);
  expect(await valid([phase([{...supplement(),product:{...product(),ingredientKeys:['same','SAME']}}])])).toBe(false);
 });
});

describe('what the candidate admits',()=>{
 it('education fields on any item kind and a catalog binding on a product, compiled verbatim into the artifact',async()=>{
  expect(await valid(educated())).toBe(true);
  const text=await compiled(educated());
  expect(text).toContain('practitioner_authored');expect(text).toContain('prd_fictional_magnesium');
  expect(text).toContain('Fictional clinician video');
  for(const kind of ['diet','habit'])expect(await valid([phase([{...lesson(),kind,...education()}])]),kind).toBe(true);
 });
 it.each([
  ['a null rationale',{rationale:null}],['an oversize rationale',{rationale:'x'.repeat(1001)}],
  ['an invented authorship',{authorship:'clinically_approved'}],['a null authorship',{authorship:null}],
  ['an insecure source',{sources:[{title:'x',url:'http://education.example.com/a'}]}],
  ['a credential-bearing source',{sources:[{title:'x',url:'https://user:secret@education.example.com/a'}]}],
  ['a source without a title',{sources:[{url:'https://education.example.com/a'}]}],
  ['a blank source title',{sources:[{title:'   ',url:'https://education.example.com/a'}]}],
  ['an unknown source field',{sources:[{title:'x',url:'https://education.example.com/a',affiliate:true}]}],
  ['eleven sources',{sources:Array.from({length:11},(_,i)=>({title:'s'+i,url:'https://education.example.com/'+i}))}],
  ['an unknown media kind',{media:[{kind:'audio',url:'https://media.example.com/a'}]}],
  ['an insecure media address',{media:[{kind:'image',url:'http://media.example.com/a.png'}]}],
  ['an oversize caption',{media:[{kind:'image',url:'https://media.example.com/a.png',caption:'c'.repeat(241)}]}],
  ['a null caption',{media:[{kind:'image',url:'https://media.example.com/a.png',caption:null}]}],
  ['six media slots',{media:Array.from({length:6},(_,i)=>({kind:'image',url:'https://media.example.com/'+i}))}],
  ['media that is not an array',{media:{kind:'image',url:'https://media.example.com/a.png'}}],
  ['an unknown field beside the education fields',{dosingAdvice:'take two'}],
 ])('refuses %s',async(_name,bad)=>{
  expect(await valid([phase([{...lesson(),...bad}])])).toBe(false);
 });
 it.each([
  ['a free-text stable id',{...binding(),stableId:'Magnesium Glycinate'}],
  ['a label id',{...binding(),stableId:'lbl_fictional'}],
  ['a zero version',{...binding(),version:0}],['a fractional version',{...binding(),version:1.5}],
  ['a string version',{...binding(),version:'3'}],['an invented target',{...binding(),target:'sandbox'}],
  ['a missing target',{stableId:'prd_fictional_magnesium',version:3}],
  ['an unknown field inside the binding',{...binding(),destinationUrl:'https://shop.example.com/x'}],
  ['a null binding',null],
 ])('refuses a catalog binding with %s',async(_name,bad)=>{
  expect(await valid([phase([{...supplement(),product:{...product(),catalog:bad}}])])).toBe(false);
 });
 it('still keeps a binding off a lesson, because it rides on a product',async()=>{
  expect(await valid([phase([{...lesson(),product:{...product(),catalog:binding()}}])])).toBe(false);
 });
 it('returns the authored patient program on the version detail, JSON null when none is authored',async()=>{
  const detail=async(version:string)=>(await db.query<{d:Record<string,unknown>}>('select clinical_private.synthetic_program_version_detail($1) as d',[version])).rows[0]!.d;
  const withProgram=await detail(authored);
  expect(withProgram).toHaveProperty('consumerProgram');
  expect((withProgram.consumerProgram as {title:string}).title).toBe('Fictional guide');
  expect(withProgram.modules).toEqual([]);
  const without=await detail(bare);
  expect(without).toHaveProperty('consumerProgram');expect(without.consumerProgram).toBeNull();
 });
});
