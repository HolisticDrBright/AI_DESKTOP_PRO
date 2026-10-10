/** Real concurrent sessions on the runner's disposable LOCAL source cluster.
 * Not an AWS harness, an owner profile or provider/activation evidence. */
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
const sha=value=>createHash('sha256').update(value).digest('hex');
const canonical=value=>Array.isArray(value)?'['+value.map(canonical).join(',')+']':value&&typeof value==='object'
  ?'{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}':JSON.stringify(value);
const sql='select clinical_core.transfer_telehealth_note($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) result';
const ledgers=Object.freeze({114:'7c09615ba12bd1122d34d459c57e1c88c42f1c51d598f4f71183e472b15d802c',
  115:'cf9e9a80ec6e2973cf53ce1718ce1b48b48e6c62c90af360fb33bb45d6635119'});
const assemblies=Object.freeze({114:'8e4fc72b54015f1f0b183fa308aeba8ff3db886e6e4c236fad88bf53f7820f3e',
  115:'3172e6b60c62edbb9e9cec10fbc74fe908eb7c41bad562e499b08620d5d670a9'});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const check=(value,label)=>{if(!value)throw Error('telehealth_native_race_'+label);};
export const TELEHEALTH_NATIVE_RACE_CASES=Object.freeze([
  'private_key_read_refused','valid_and_exact_retry','expiry_during_transfer_lock','authority_revoked_during_transfer_lock',
  'key_retired_during_transfer_lock','concurrent_identical_transfer','key_retired_during_destination_lock',
]);
async function identity(client){
  const rows=(await client.query("select current_database() db,current_user::text owner,current_setting('server_version') version")).rows;
  check(Array.isArray(rows)&&rows.length===1&&rows[0]!==null&&typeof rows[0]==='object'
    &&Object.keys(rows[0]).sort().join(',')==='db,owner,version'
    &&/^alp_source_[a-f0-9]{32}$/.test(rows[0].db)&&rows[0].owner==='postgres'&&rows[0].version==='17.7','identity_refused');
  return rows[0].db;
}
function mint(f,time,expiry=60_000){
  const content=canonical({telehealth_summary:'FICTIONAL native concurrency report.',practitioner_notes:'FICTIONAL notes.'});
  const payload=canonical({aiOriginal:{summary_content:'FICTIONAL source'},practitionerNotes:'FICTIONAL notes.'});
  const provenance=canonical([{sectionKey:'telehealth_summary',refType:'telehealth_visit',refId:f.appointment,label:'FICTIONAL visit revision 2'}]);
  const digest=sha(payload),transferId=randomUUID();
  const admission=canonical({contract:'telehealth-chart-admission/1',intent:'chart_draft',key_id:f.keyId,
    transfer_id:transferId,organization_id:f.org,patient_record_id:f.patient,appointment_id:f.appointment,
    practitioner_person_id:f.person,source_custody:'telehealth-visit-record',source_record_version:6,source_revision:2,
    source_digest:digest,content_sha256:sha(content),payload_sha256:sha(payload),provenance_sha256:sha(provenance),
    issued_at:new Date(time-1000).toISOString(),expires_at:new Date(time+expiry).toISOString()});
  return {parameters:[f.org,transferId,f.appointment,f.patient,2,digest,content,payload,provenance,admission,
    createHmac('sha256',f.secret).update(admission).digest('hex')],expiresAt:new Date(time+expiry).toISOString()};
}
async function fixture(admin){
  const [org,person,patient,appointment]=Array.from({length:4},()=>randomUUID());
  const keyId='fictional-native-'+randomUUID(),secret=randomBytes(32);
  await admin.query("insert into clinical_core.organizations(id,organization_label) values($1,'FICTIONAL NATIVE SOURCE')",[org]);
  await admin.query('insert into clinical_core.persons(id,subject_key) values($1,$2)',[person,'subject_'+person.replaceAll('-','')]);
  await admin.query("insert into clinical_core.identities(person_id,identity_pool,identity_subject,production_bound) values($1,'workforce',$2,true)",[person,'fictional-subject-'+person]);
  await admin.query("insert into clinical_core.organization_memberships(organization_id,person_id,role) values($1,$2,'practitioner')",[org,person]);
  await admin.query("insert into clinical_core.patient_records(id,organization_id,patient_key,first_name,last_name) values($1,$2,$3,'FICTIONAL','PATIENT')",[patient,org,'patient_'+patient.replaceAll('-','')]);
  await admin.query(`insert into clinical_core.appointments(id,organization_id,patient_record_id,practitioner_person_id,appointment_type,status,starts_at,ends_at,created_by_person_id,updated_by_person_id)
    values($1,$2,$3,$4,'telehealth','completed','2026-10-09T17:00:00Z','2026-10-09T17:30:00Z',$4,$4)`,[appointment,org,patient,person]);
  await admin.query('insert into clinical_private.telehealth_admission_keys(key_id,secret) values($1,$2)',[keyId,secret]);
  return {org,person,patient,appointment,keyId,secret};
}
async function transfer(client,f,minted){
  try{
    await client.query('begin');await client.query('set local role clinical_core_api');
    check((await client.query('select current_user::text role')).rows[0]?.role==='clinical_core_api','restricted_role_refused');
    await client.query("set local lock_timeout='8s'");await client.query("set local statement_timeout='15s'");
    await client.query("select clinical_private.set_request_context($1,$2,'workforce',$3,'clinical_data','production-clinical','clinical_phi')",
      [f.person,f.org,'fictional-subject-'+f.person]);
    const result=(await client.query(sql,minted.parameters)).rows[0]?.result;
    await client.query('commit');return {status:'fulfilled',result};
  }catch(error){
    await client.query('rollback');
    const message=String(error?.message??'');
    const category=/^(telehealth_admission_(mismatch|refused|unavailable)|clinical_role_required|request_context_refused|patient_not_found|membership_required)$/.test(message)?message:'unexpected_database_error';
    return {status:'refused',category};
  }
}
async function currentTime(admin){return Number((await admin.query('select extract(epoch from clock_timestamp())*1000 ms')).rows[0].ms);}
async function counts(admin,f){
  const result=(await admin.query(`select
    (select count(*)::int from clinical_core.encounters where organization_id=$1) encounters,
    (select count(*)::int from clinical_core.clinical_notes where organization_id=$1) notes,
    (select count(*)::int from clinical_core.telehealth_note_transfers where organization_id=$1) transfers,
    (select count(*)::int from clinical_audit.events where organization_id=$1 and action in('encounter.started','note.draft_created','telehealth.note_transferred')) audits`,[f.org])).rows[0];
  check(Object.values(result).every(Number.isSafeInteger),'counts_refused');return result;
}
async function waitBlocked(observer,writer,blocker){
  const until=Date.now()+3000;
  while(Date.now()<until){
    const r=(await observer.query('select pg_blocking_pids($1) pids',[writer])).rows[0];
    if(Array.isArray(r?.pids)&&r.pids.includes(blocker))return true;
    await pause(25);
  }
  throw Error('telehealth_native_race_block_not_observed');
}
async function hold(blocker,f,destination=false){
  await blocker.query('begin');
  await blocker.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[destination?f.appointment:'telehealth-transfer:'+f.appointment]);
}
const refused=(outcome,allowed)=>outcome.status==='refused'&&allowed.includes(outcome.category);
const zero=c=>Object.values(c).every(value=>value===0);

export async function runTelehealthNativeRaces(admin,createClient){
  const databaseName=await identity(admin);
  const ledger=(await admin.query('select version,name,sha256 from clinical_core.schema_migrations order by version limit 116')).rows;
  check(Array.isArray(ledger)&&Object.hasOwn(ledgers,ledger.length)
    &&ledger.every((row,i)=>row&&Object.keys(row).sort().join(',')==='name,sha256,version'
      &&typeof row.name==='string'&&/^[a-z0-9_]+$/.test(row.name)&&typeof row.version==='string'&&/^\d{14}$/.test(row.version)
      &&typeof row.sha256==='string'&&/^[a-f0-9]{64}$/.test(row.sha256)&&(i===0||row.version>ledger[i-1].version))
    &&sha(ledger.map(row=>row.version+':'+row.sha256).join('\n'))===ledgers[ledger.length]
    &&sha(ledger.map(row=>row.version+':'+row.version+'_'+row.name+'.sql:'+row.sha256).join('\n'))===assemblies[ledger.length],'ledger_refused');
  const sessions=[],cases=[];
  try{
    for(let i=0;i<4;i++){
      const client=await createClient();sessions.push(client);
      check(await identity(client)===databaseName,'session_binding_refused');
      await client.query("set statement_timeout='15s'");
    }
    const [writer,writer2,blocker,retirer]=sessions;
    const pid=async c=>(await c.query('select pg_backend_pid() pid')).rows[0].pid;
    const [writerPid,secondPid,blockerPid,retirerPid]=await Promise.all(sessions.map(pid));
    check(new Set([writerPid,secondPid,blockerPid,retirerPid]).size===4,'sessions_not_independent');
    for(const id of TELEHEALTH_NATIVE_RACE_CASES){
      const f=await fixture(admin),minted=mint(f,await currentTime(admin),id==='expiry_during_transfer_lock'?2000:60_000);
      if(id==='private_key_read_refused'){
        let denied=false;
        await writer.query('begin');await writer.query('set local role clinical_core_api');
        check((await writer.query('select current_user::text role')).rows[0]?.role==='clinical_core_api','restricted_role_refused');
        try{await writer.query('select key_id from clinical_private.telehealth_admission_keys');}catch(error){denied=error.code==='42501';}
        finally{await writer.query('rollback');}
        const c=await counts(admin,f);cases.push({id,passed:denied&&zero(c),counts:c});continue;
      }
      if(id==='valid_and_exact_retry'){
        const first=await transfer(writer,f,minted),retry=await transfer(writer,f,minted),c=await counts(admin,f);
        cases.push({id,passed:first.status==='fulfilled'&&first.result.created===true&&retry.status==='fulfilled'&&retry.result.created===false
          &&first.result.note_id===retry.result.note_id&&c.encounters===1&&c.notes===1&&c.transfers===1&&c.audits===3,counts:c});continue;
      }
      let pending,second,retirement,blockedObserved=false,retirementBlockedObserved=false,retirementCommittedBeforeRelease=false;
      try{
        await hold(blocker,f,id==='key_retired_during_destination_lock');
        pending=transfer(writer,f,minted);
        blockedObserved=await waitBlocked(admin,writerPid,blockerPid);
        if(id==='expiry_during_transfer_lock'){
          await admin.query('select pg_sleep(greatest(0,extract(epoch from ($1::timestamptz-clock_timestamp()))+0.1))',[minted.expiresAt]);
        }else if(id==='authority_revoked_during_transfer_lock'){
          await admin.query("update clinical_core.organization_memberships set status='suspended' where person_id=$1",[f.person]);
        }else if(id==='key_retired_during_transfer_lock'){
          await admin.query('update clinical_private.telehealth_admission_keys set retired_at=clock_timestamp() where key_id=$1',[f.keyId]);
        }else if(id==='key_retired_during_destination_lock'){
          let settled=false;
          retirement=retirer.query('update clinical_private.telehealth_admission_keys set retired_at=clock_timestamp() where key_id=$1',[f.keyId])
            .then(()=>{settled=true;return true;},()=>{settled=true;return false;});
          const until=Date.now()+3000;
          while(Date.now()<until){
            if(settled){retirementCommittedBeforeRelease=await retirement;break;}
            const pids=(await admin.query('select pg_blocking_pids($1) pids',[retirerPid])).rows[0]?.pids;
            if(Array.isArray(pids)&&pids.includes(writerPid)){retirementBlockedObserved=true;break;}
            await pause(25);
          }
          check(retirementBlockedObserved||retirementCommittedBeforeRelease,'retirement_order_not_observed');
        }else if(id==='concurrent_identical_transfer'){
          second=transfer(writer2,f,minted);
          // PostgreSQL may report the earlier waiter as a soft blocker.
          try{await waitBlocked(admin,secondPid,blockerPid);}catch{await waitBlocked(admin,secondPid,writerPid);}
        }
      }finally{await blocker.query('rollback');}
      const outcome=await pending,c=await counts(admin,f);
      if(retirement){
        const retired=await retirement;
        const retry=await transfer(writer,f,minted),after=await counts(admin,f);
        const key=(await admin.query('select retired_at is not null retired from clinical_private.telehealth_admission_keys where key_id=$1',[f.keyId])).rows[0];
        cases.push({id,blockedObserved,retirementBlockedObserved,retirementCommittedBeforeRelease,
          passed:retired&&key?.retired===true&&refused(retry,['telehealth_admission_refused'])&&JSON.stringify(c)===JSON.stringify(after)
            &&(retirementBlockedObserved?outcome.status==='fulfilled'&&c.encounters===1&&c.notes===1&&c.transfers===1&&c.audits===3
              :refused(outcome,['telehealth_admission_refused'])&&zero(c)),observedStatus:outcome.status,
          postRetirementRefusal:retry.category,counts:c});continue;
      }
      if(second){
        const other=await second;
        cases.push({id,blockedObserved,passed:outcome.status==='fulfilled'&&other.status==='fulfilled'
          &&[outcome.result.created,other.result.created].filter(Boolean).length===1&&outcome.result.note_id===other.result.note_id
          &&c.notes===1&&c.encounters===1&&c.transfers===1&&c.audits===3,counts:c});
      }else{
        const allowed=id==='expiry_during_transfer_lock'?['telehealth_admission_mismatch']:id==='authority_revoked_during_transfer_lock'
          ?['clinical_role_required','request_context_refused','membership_required']:['telehealth_admission_refused'];
        cases.push({id,blockedObserved,passed:refused(outcome,allowed)&&zero(c),observedStatus:outcome.status,
          ...(outcome.status==='refused'?{observedRefusal:outcome.category}:{}),counts:c});
      }
    }
    return {contract:'telehealth-native-races/1',execution:'local_fictional_sql_matrix',sourceOnly:true,
      providerAuthorized:false,upgradeAuthorized:false,phiAllowed:false,activation:'blocked',
      sourceMigrationCount:ledger.length,
      mandatoryCases:TELEHEALTH_NATIVE_RACE_CASES.length,cases,verdict:cases.length===TELEHEALTH_NATIVE_RACE_CASES.length&&cases.every(c=>c.passed)?'passed':'failed'};
  }finally{
    for(const client of sessions){await client.query('rollback').catch(()=>{});await client.end();}
  }
}
