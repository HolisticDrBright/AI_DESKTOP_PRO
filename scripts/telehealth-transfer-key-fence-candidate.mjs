import { createHash } from 'node:crypto';
const sha=value=>createHash('sha256').update(value).digest('hex');
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
export const TELEHEALTH_KEY_FENCE_FILE='20261010210000_production_telehealth_transfer_key_fence.sql';
export const TELEHEALTH_KEY_FENCE_SQL_SHA256='813d2adebd908050f9307871b0ac0476a249d7c5abf45710c1ea4d5f851ba456';
export const TELEHEALTH_KEY_FENCE_PARENT=Object.freeze({count:114,
  ledger:'7c09615ba12bd1122d34d459c57e1c88c42f1c51d598f4f71183e472b15d802c',
  assembly:'8e4fc72b54015f1f0b183fa308aeba8ff3db886e6e4c236fad88bf53f7820f3e'});
const expectedParent=Object.freeze({contract:'zoom-host-authority-candidate/1',parentContract:'telehealth-chart-lifecycle-candidate/4',
  parentMigrationCount:113,parentMigrationReleaseSha256:'c980ff93f46b4e4fe36360a0f39288a2fb604a87c522ee88d4421f35f6035384',
  parentArtifactSha256:'f940e0aacbf8a8899ea21fbb027f6132044608492baf1a9286502637b57d3ce2',
  migrationCount:114,migrationReleaseSha256:TELEHEALTH_KEY_FENCE_PARENT.ledger,
  extensionSha256:'7cddacc6aa38a4abb3bf55a5548eac48717ea420d8f811870502c9a9d19764fe',
  functionPinsSha256:'fc9b07b3ba6ed4c69c2d92ec3738c682cb44848204d73d95b8acd8c74fb6997a',
  deployment:'not_deployed',activation:'blocked',phiAllowed:false,seededApprovals:false,seededConsents:false,
  seededAdmissionKeys:false,seededHostReleases:false,seededHostBindings:false,seededIdentities:false});
const ledger=a=>sha(a.manifest.migrations.map(m=>m.version+':'+sha(a.files[m.file])).join('\n'));
const assembly=a=>sha(a.manifest.migrations.map(m=>m.version+':'+m.file+':'+sha(a.files[m.file])).join('\n'));
export function telehealthTransferKeyFenceCandidate(parent,source){
  const refuse=()=>{throw Error('telehealth_key_fence_artifact_refused');};
  if(!record(parent)||!record(parent.manifest)||Object.keys(parent.manifest).length!==2
    ||parent.manifest.contract_version!=='clinical-core-migrations/1'||!Array.isArray(parent.manifest.migrations)
    ||parent.manifest.migrations.length!==114||!record(parent.files)||!record(parent.candidate)
    ||Object.keys(parent.candidate).sort().join(',')!==Object.keys(expectedParent).sort().join(',')
    ||Object.entries(expectedParent).some(([key,value])=>parent.candidate[key]!==value)
    ||!Array.isArray(parent.functionPins)||sha(JSON.stringify(parent.functionPins))!==expectedParent.functionPinsSha256
    ||typeof source!=='string')refuse();
  const rows=parent.manifest.migrations;
  if(rows.some((m,i)=>!record(m)||Object.keys(m).sort().join(',')!=='file,version'||typeof m.version!=='string'
    ||!/^\d{14}$/.test(m.version)||typeof m.file!=='string'||!/^\d{14}_[a-z0-9_]+\.sql$/.test(m.file)
    ||m.file.slice(0,14)!==m.version||typeof parent.files[m.file]!=='string'||parent.files[m.file].includes('\r')
    ||i>0&&m.version<=rows[i-1].version)
    ||Object.keys(parent.files).sort().join('\n')!==rows.map(m=>m.file).sort().join('\n')
    ||ledger(parent)!==TELEHEALTH_KEY_FENCE_PARENT.ledger||assembly(parent)!==TELEHEALTH_KEY_FENCE_PARENT.assembly
    ||parent.releaseHash!==TELEHEALTH_KEY_FENCE_PARENT.assembly)refuse();
  const sql=source.replace(/\r\n?/g,'\n');
  if(sha(sql)!==TELEHEALTH_KEY_FENCE_SQL_SHA256||TELEHEALTH_KEY_FENCE_FILE.slice(0,14)<=rows.at(-1).version)refuse();
  const manifest={...parent.manifest,migrations:[...rows.map(m=>({...m})),
    {version:TELEHEALTH_KEY_FENCE_FILE.slice(0,14),file:TELEHEALTH_KEY_FENCE_FILE}]};
  const files={...parent.files,[TELEHEALTH_KEY_FENCE_FILE]:sql},artifact={manifest,files};
  return {...artifact,releaseHash:assembly(artifact),candidate:{contract:'telehealth-transfer-key-fence-candidate/1',
    parentMigrationCount:114,parentMigrationReleaseSha256:TELEHEALTH_KEY_FENCE_PARENT.ledger,
    parentArtifactSha256:TELEHEALTH_KEY_FENCE_PARENT.assembly,migrationCount:115,migrationReleaseSha256:ledger(artifact),
    extensionSha256:sha(sql),deployment:'not_deployed',activation:'blocked',phiAllowed:false,
    seededApprovals:false,seededConsents:false,seededAdmissionKeys:false,seededTransfers:false}};
}
