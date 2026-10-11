import {lstatSync} from 'node:fs';
import {FullscriptUpgradeError} from './fullscript-schema-upgrade';

/** Descriptor-bounded reads are supplied by native custody. Pin identity as
 * well as bytes: replacing an archive with identical bytes is not the original
 * reviewed custody. This closure does no DB work and retires nothing. */
export function pinSchemaCustodyFiles(files:readonly {path:string;bytes:Buffer}[],read:(path:string,maximum:number)=>Buffer){
  const fail=()=>{throw new FullscriptUpgradeError('custody_refused','prepared_custody_changed');};
  const pins=files.map(file=>{
    const s=lstatSync(file.path),expected=Buffer.from(file.bytes),maximum=Math.max(expected.length,16384);
    if(!s.isFile()||s.isSymbolicLink()||!read(file.path,maximum).equals(expected))fail();
    return {path:file.path,expected,maximum,ino:s.ino,dev:s.dev,size:s.size,mtimeMs:s.mtimeMs};
  });
  return ()=>{for(const p of pins){
    const s=lstatSync(p.path);
    if(!s.isFile()||s.isSymbolicLink()||s.ino!==p.ino||s.dev!==p.dev||s.size!==p.size||s.mtimeMs!==p.mtimeMs
      ||!read(p.path,p.maximum).equals(p.expected))fail();
  }};
}
