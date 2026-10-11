/** Source-only restricted owner. Never admits Aurora, an existing target or a
 * superuser disguised with SET ROLE. Managed rds_superuser semantics are not
 * emulated by this local role profile. */
export const RESTRICTED_SOURCE_OWNER_IDENTITY_SQL = `select
 current_database() database_name,current_user::text owner,session_user::text session_owner,
 current_setting('server_version') version,pg_get_userbyid(d.datdba) database_owner,
 r.rolsuper,r.rolcreaterole,r.rolcreatedb,r.rolinherit,r.rolbypassrls,r.rolcanlogin,r.rolreplication
 from pg_roles r join pg_database d on d.datname=current_database() where r.rolname=current_user`;
const expected = Object.freeze({ owner:'clinical_admin',session_owner:'clinical_admin',database_owner:'clinical_admin',version:'17.7',
  rolsuper:false,rolcreaterole:true,rolcreatedb:true,rolinherit:true,rolbypassrls:false,rolcanlogin:true,rolreplication:false });
export function assertRestrictedSourceOwnerIdentity(rows) {
  if(!Array.isArray(rows)||rows.length!==1||!rows[0]||typeof rows[0]!=='object'||Array.isArray(rows[0])
    ||Object.keys(rows[0]).sort().join(',')!==['database_name',...Object.keys(expected)].sort().join(',')
    ||typeof rows[0].database_name!=='string'||!/^alp_owner_source_[a-f0-9]{32}$/.test(rows[0].database_name)
    ||Object.entries(expected).some(([key,value])=>rows[0][key]!==value))
    throw Error('telehealth_restricted_source_owner_refused');
  return { contract:'telehealth-restricted-source-owner/1',...rows[0],sourceOnly:true,managedRoleSemanticsVerified:false,
    runtimeAdmission:false,providerAuthorized:false,upgradeAuthorized:false,phiAllowed:false,activation:'blocked' };
}
