import {describe,it,expect} from 'vitest';
import {correctionEntryListDiff,correctionInputSchema,isCorrectionEntry,isCorrectionEntryList,CORRECTION_ENTRY_KEYS_MAX} from './personalCorrection';
const base={version:'personal-correction/1',collection:'wellness_profiles',recordId:'11111111-1111-4111-8111-111111111111',expectedRevision:3,expectedPayloadSha256:'a'.repeat(64),field:'medications',reason:'Fictional'} as const;
describe('personal correction entry lists',()=>{
  it('accepts flat entries of plain values or lists of them and refuses nesting, unsafe keys and oversized entries',()=>{
    expect(isCorrectionEntry({id:'m1',name:'Fictional A',dose_mg:5,times:['08:00'],active:true})).toBe(true);
    expect(isCorrectionEntry({})).toBe(false);
    expect(isCorrectionEntry({nested:{a:1}})).toBe(false);
    expect(isCorrectionEntry({'a.b':1})).toBe(false);
    expect(isCorrectionEntry({'1x':1})).toBe(false);
    expect(isCorrectionEntry({__proto__:1,x:1})).toBe(true); // literal __proto__ sets the prototype, so only x is an own key
    expect(isCorrectionEntry(JSON.parse('{"__proto__":1}'))).toBe(false);
    expect(isCorrectionEntry({list:[{a:1}]})).toBe(false);
    expect(isCorrectionEntry(Object.fromEntries(Array.from({length:CORRECTION_ENTRY_KEYS_MAX+1},(_,i)=>['k'+i,i])))).toBe(false);
    expect(isCorrectionEntryList([])).toBe(true);
    expect(isCorrectionEntryList([{a:1},'x'])).toBe(false);
    expect(correctionInputSchema.safeParse({...base,requestedValue:[{id:'m1',dose_mg:5}]}).success).toBe(true);
    expect(correctionInputSchema.safeParse({...base,requestedValue:[{id:'m1',nested:{a:1}}]}).success).toBe(false);
    expect(correctionInputSchema.safeParse({...base,requestedValue:{id:'m1'}}).success).toBe(false);
  });
  it('diffs by unique string id when every entry on both sides has one, otherwise by position',()=>{
    const before=[{id:'m1',dose_mg:5,name:'A'},{id:'m2',dose_mg:10,name:'B'}];
    const after=[{id:'m2',dose_mg:10,name:'B'},{id:'m1',dose_mg:7.5,name:'A'},{id:'m3',dose_mg:1,name:'C'}];
    expect(correctionEntryListDiff(before,after)).toEqual({identity:'id',unchanged:1,added:[{key:'m3',entry:after[2]}],removed:[],
      changed:[{key:'m1',before:before[0],after:after[1],fields:['dose_mg']}]});
    expect(correctionEntryListDiff(before,[before[0]])).toMatchObject({identity:'id',removed:[{key:'m2',entry:before[1]}],unchanged:1});
    // Duplicate or missing ids fall back to position so nothing is silently merged.
    expect(correctionEntryListDiff(before,[{id:'m1',dose_mg:5,name:'A'},{id:'m1',dose_mg:10,name:'B'}])).toMatchObject({identity:'index',changed:[{key:'1',fields:['id']}]});
    expect(correctionEntryListDiff([{text:'a'},{text:'b'}],[{text:'a'},{text:'c'},{text:'d'}])).toEqual({identity:'index',unchanged:1,added:[{key:'2',entry:{text:'d'}}],removed:[],
      changed:[{key:'1',before:{text:'b'},after:{text:'c'},fields:['text']}]});
    // A key present on one side only counts as a changed field.
    expect(correctionEntryListDiff([{id:'x',a:1}],[{id:'x',a:1,b:2}])).toMatchObject({changed:[{key:'x',fields:['b']}]});
    expect(correctionEntryListDiff([{id:'x',l:[1,2]}],[{id:'x',l:[1,2]}])).toMatchObject({unchanged:1,changed:[]});
  });
});
