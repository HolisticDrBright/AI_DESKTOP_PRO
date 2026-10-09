'use strict';
// eslint-disable-next-line @typescript-eslint/no-require-imports -- The pinned Next caller loads a synchronous CommonJS module.
const {globSync:directories}=require('tinyglobby');
// eslint-disable-next-line @typescript-eslint/no-require-imports -- CommonJS interop, not a change to application lint rules.
const {isAbsolute,parse}=require('node:path');
// eslint-disable-next-line @typescript-eslint/no-require-imports -- Literal directory lookup is synchronous to match the Next caller.
const {statSync}=require('node:fs');

// Next 15.5.25's only fast-glob call is get-root-dirs.js:
// globSync(pattern, {onlyDirectories:true}). Do not silently claim to provide
// fast-glob's general API. A changed upstream consumer must fail its CI pin.
function globSync(pattern,options){
  if(typeof pattern!=='string'||pattern.length===0||pattern.length>4096||pattern.includes('\0')
    ||!options||options.onlyDirectories!==true||Object.keys(options).some(key=>key!=='onlyDirectories'))
    throw new TypeError('next_root_glob_invalid');
  // Reject unbounded nested brace/extglob parsing before touching the matcher.
  let depth=0,escaped=false,inClass=false;
  for(const character of pattern){
    if(escaped){escaped=false;continue;}
    if(character==='\\'){escaped=true;continue;}
    if(character==='['){inClass=true;continue;}
    if(character===']'){inClass=false;continue;}
    if(inClass)continue;
    if(character==='{'||character==='('){if(++depth>32)throw new TypeError('next_root_glob_invalid');}
    else if(character==='}'||character===')')depth=Math.max(0,depth-1);
  }
  // Static roots retain their original spelling (./src/, C:/, etc.) and do
  // not walk their descendants. tinyglobby normalizes those spellings and
  // cannot match a filesystem root on Windows by itself.
  if(!/[\\*?{}()[\]!+@]/.test(pattern)){
    try{return statSync(pattern).isDirectory()?[pattern]:[];}
    catch(error){if(error.code==='ENOENT'||error.code==='ENOTDIR')return [];throw error;}
  }
  // tinyglobby expands literal directory patterns recursively by default,
  // unlike the Next caller's old fast-glob use. Preserve literal-root semantics.
  return directories(pattern,{onlyDirectories:true,expandDirectories:false,absolute:isAbsolute(pattern)}).map(value=>{
    const result=value.endsWith('/')&&value!==parse(value).root?value.slice(0,-1):value;
    return pattern.startsWith('./')&&!result.startsWith('./')?`./${result}`:result;
  });
}
module.exports={globSync};
