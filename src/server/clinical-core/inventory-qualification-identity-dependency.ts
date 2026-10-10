if (typeof window !== 'undefined') throw Error('inventory identity dependency observation is server-only');
import { execFileSync } from 'node:child_process';
import { inventoryCanonical, inventoryRecord, inventoryRefuse, inventorySha } from './inventory-qualification-artifacts';
import { isInventoryCognitoSubject } from './inventory-cognito-subject';
import { inventoryServiceReader, type InventoryServiceRead } from './inventory-qualification-service-observer';
import type { InventoryQualificationTarget } from './inventory-qualification-target';

type Row = Record<string, unknown>;
export type InventoryIdentityDependency = { identity: InventoryQualificationTarget['identity']; organizationId: string;
  subjects: Pick<InventoryQualificationTarget['target']['identitySubjects'], 'consumer' | 'foreignConsumer' | 'workforce'> };
const account = '588966314750', region = 'us-east-2';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const obj = (v: unknown): Row => inventoryRecord(v) ? v : inventoryRefuse('identity_dependency_shape_refused');
const same = (a: unknown, b: unknown) => {
  if (a === undefined || b === undefined) { if (a !== b) inventoryRefuse('identity_dependency_refused'); return; }
  if (inventoryCanonical(a) !== inventoryCanonical(b)) inventoryRefuse('identity_dependency_refused');
};
function set(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 128 || new Set(value).size !== value.length
    || value.some(v => typeof v !== 'string' || !v.length || v.length > 256)) return inventoryRefuse('identity_dependency_shape_refused');
  return [...value].sort();
}

// The CLI only emits a fixed non-secret configuration projection. In particular
// DescribeUserPoolClient can contain ClientSecret: retain only its presence,
// never its value. AdminGetUser is subject-addressed, not a pool-wide user scan;
// omit names, emails, phones, addresses and all unneeded attribute values.
const projections = {
  'describe-user-pool': '{UserPool:UserPool.{Id:Id,Arn:Arn,Status:Status,DeletionProtection:DeletionProtection,UsernameAttributes:UsernameAttributes,UsernameConfiguration:UsernameConfiguration,AutoVerifiedAttributes:AutoVerifiedAttributes,MfaConfiguration:MfaConfiguration,SoftwareTokenMfaConfiguration:SoftwareTokenMfaConfiguration,AccountRecoverySetting:AccountRecoverySetting,Policies:Policies,SchemaAttributes:SchemaAttributes,UserPoolTags:UserPoolTags,LambdaConfig:LambdaConfig,LastModifiedDate:LastModifiedDate,UserPoolAddOns:UserPoolAddOns,DeviceConfiguration:DeviceConfiguration,AdminCreateUserConfig:AdminCreateUserConfig}}',
  'describe-user-pool-client': '{UserPoolClient:UserPoolClient.{UserPoolId:UserPoolId,ClientId:ClientId,HasClientSecret:ClientSecret != `null`,PreventUserExistenceErrors:PreventUserExistenceErrors,EnableTokenRevocation:EnableTokenRevocation,ExplicitAuthFlows:ExplicitAuthFlows,AccessTokenValidity:AccessTokenValidity,IdTokenValidity:IdTokenValidity,RefreshTokenValidity:RefreshTokenValidity,TokenValidityUnits:TokenValidityUnits,ReadAttributes:ReadAttributes,WriteAttributes:WriteAttributes,AllowedOAuthFlowsUserPoolClient:AllowedOAuthFlowsUserPoolClient,AllowedOAuthFlows:AllowedOAuthFlows,AllowedOAuthScopes:AllowedOAuthScopes,CallbackURLs:CallbackURLs,LogoutURLs:LogoutURLs,SupportedIdentityProviders:SupportedIdentityProviders,RefreshTokenRotation:RefreshTokenRotation,EnablePropagateAdditionalUserContextData:EnablePropagateAdditionalUserContextData,LastModifiedDate:LastModifiedDate}}',
  'get-user-pool-mfa-config': '{MfaConfiguration:MfaConfiguration,SoftwareTokenMfaConfiguration:SoftwareTokenMfaConfiguration,SmsMfaConfiguration:SmsMfaConfiguration,EmailMfaConfiguration:EmailMfaConfiguration,WebAuthnConfiguration:WebAuthnConfiguration}',
  'admin-get-user': '{Enabled:Enabled,UserStatus:UserStatus,PreferredMfaSetting:PreferredMfaSetting,UserMFASettingList:UserMFASettingList,UserLastModifiedDate:UserLastModifiedDate,UserAttributes:UserAttributes[?Name == `sub` || Name == `email_verified` || Name == `custom:person_id` || Name == `custom:organization_id` || Name == `custom:synthetic_attested` || Name == `custom:production_bound`]}',
} as const;
export function inventoryIdentityReader(execute: typeof execFileSync = execFileSync): InventoryServiceRead {
  const serviceRead = inventoryServiceReader(execute);
  return async (service, operation, parameters) => {
    if (service === 'sts' && operation === 'get-caller-identity') return serviceRead(service, operation, parameters);
    if (service !== 'cognito-idp' || !Object.hasOwn(projections, operation)) return inventoryRefuse('identity_read_operation_refused');
    const names = operation === 'describe-user-pool-client' ? ['UserPoolId', 'ClientId']
      : operation === 'admin-get-user' ? ['UserPoolId', 'Username'] : ['UserPoolId'];
    if (Object.keys(parameters).sort().join(',') !== [...names].sort().join(',')
      || typeof parameters.UserPoolId !== 'string' || !/^us-east-2_[A-Za-z0-9]+$/.test(parameters.UserPoolId)
      || operation === 'describe-user-pool-client' && (typeof parameters.ClientId !== 'string' || !/^[A-Za-z0-9]{20,128}$/.test(parameters.ClientId))
      || operation === 'admin-get-user' && !isInventoryCognitoSubject(parameters.Username))
      return inventoryRefuse('identity_read_operation_refused');
    const args = [service, operation];
    for (const name of names) args.push('--' + name.replace(/[A-Z]/g, (v, n) => (n ? '-' : '') + v.toLowerCase()), parameters[name] as string);
    args.push('--query', projections[operation as keyof typeof projections], '--profile', 'ai-synthetic-member', '--region', region,
      '--output', 'json', '--no-cli-pager');
    try {
      return JSON.parse(String(execute('aws', args, { encoding: 'utf8', windowsHide: true, timeout: 30000,
        maxBuffer: 1024 * 1024, env: { ...process.env, AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: 'true', AWS_MAX_ATTEMPTS: '1',
          AWS_CLI_AUTO_PROMPT: 'off' }, stdio: ['ignore', 'pipe', 'pipe'] })));
    } catch { return inventoryRefuse('identity_aws_read_failed'); }
  };
}

function inspectPool(raw: unknown, poolId: string, workforce: boolean) {
  const p = obj(obj(raw).UserPool);
  for (const [name, value] of Object.entries({ Id: poolId, Arn: `arn:aws:cognito-idp:${region}:${account}:userpool/${poolId}`,
    DeletionProtection: 'ACTIVE', UsernameConfiguration: { CaseSensitive: false }, MfaConfiguration: workforce ? 'ON' : 'OPTIONAL',
    AccountRecoverySetting: { RecoveryMechanisms: [{ Name: 'verified_email', Priority: 1 }] } })) same(p[name], value);
  if (p.Status !== undefined && p.Status !== null && p.Status !== 'Enabled') return inventoryRefuse('identity_dependency_refused');
  same(set(p.UsernameAttributes), ['email']); same(set(p.AutoVerifiedAttributes), ['email']);
  same(p.LambdaConfig ?? {}, {});
  if (p.DeviceConfiguration != null || p.UserPoolAddOns != null) return inventoryRefuse('identity_dependency_refused');
  const tags = obj(p.UserPoolTags); same(tags.Environment, 'synthetic-staging'); same(tags.DataClassification, 'synthetic_only');
  if (tags.ContainsPhi !== undefined && tags.ContainsPhi !== 'false') return inventoryRefuse('identity_dependency_refused');
  same(p.Policies, { PasswordPolicy: { MinimumLength: workforce ? 14 : 12, RequireLowercase: true, RequireNumbers: true,
    RequireSymbols: true, RequireUppercase: true, TemporaryPasswordValidityDays: 1 },
    // Cognito returns this explicit policy even for password-only pools. Do not
    // reject that safe AWS shape or silently admit passwordless first factors.
    SignInPolicy: { AllowedFirstAuthFactors: ['PASSWORD'] } });
  if (!Array.isArray(p.SchemaAttributes) || p.SchemaAttributes.length > 128) return inventoryRefuse('identity_dependency_shape_refused');
  const schema = new Map<string, Row>();
  for (const v of p.SchemaAttributes) {
    const a = obj(v); if (typeof a.Name !== 'string' || schema.has(a.Name)) return inventoryRefuse('identity_dependency_shape_refused');
    schema.set(a.Name, a);
  }
  for (const [name, length] of [['person_id', '36'], ['organization_id', '36'], ['synthetic_attested', '4'], ['production_bound', '4']]) {
    const a = schema.get(`custom:${name}`); if (!a) return inventoryRefuse('identity_dependency_refused');
    for (const [key, value] of Object.entries({ AttributeDataType: 'String', Mutable: false, Required: false,
      StringAttributeConstraints: { MinLength: length, MaxLength: length } })) same(a[key], value);
    if (a.DeveloperOnlyAttribute === true) return inventoryRefuse('identity_dependency_refused');
  }
  if ([...schema.keys()].some(n => n.startsWith('custom:') && !['person_id', 'organization_id', 'synthetic_attested', 'production_bound'].includes(n.slice(7))))
    return inventoryRefuse('identity_dependency_refused');
}
function inspectClient(raw: unknown, poolId: string, clientId: string) {
  const c = obj(obj(raw).UserPoolClient);
  for (const [name, value] of Object.entries({ UserPoolId: poolId, ClientId: clientId, HasClientSecret: false,
    PreventUserExistenceErrors: 'ENABLED', EnableTokenRevocation: true, AccessTokenValidity: 15, IdTokenValidity: 15,
    RefreshTokenValidity: 12, TokenValidityUnits: { AccessToken: 'minutes', IdToken: 'minutes', RefreshToken: 'hours' } })) same(c[name], value);
  same(set(c.ExplicitAuthFlows), ['ALLOW_USER_SRP_AUTH', 'ALLOW_USER_PASSWORD_AUTH', 'ALLOW_ADMIN_USER_PASSWORD_AUTH', 'ALLOW_REFRESH_TOKEN_AUTH'].sort());
  same(set(c.ReadAttributes), ['email', 'email_verified', 'custom:person_id', 'custom:organization_id', 'custom:synthetic_attested', 'custom:production_bound'].sort());
  // Missing WriteAttributes means default standard-attribute writes, NOT an
  // empty permission set. Fail rather than assuming a safe default.
  same(set(c.WriteAttributes), ['email']);
  for (const name of ['AllowedOAuthFlows', 'AllowedOAuthScopes', 'CallbackURLs', 'LogoutURLs']) same(set(c[name] ?? []), []);
  if (c.AllowedOAuthFlowsUserPoolClient === true || c.EnablePropagateAdditionalUserContextData === true
    || c.RefreshTokenRotation != null || Object.hasOwn(c, 'ClientSecret')) return inventoryRefuse('identity_dependency_refused');
  same(set(c.SupportedIdentityProviders ?? ['COGNITO']), ['COGNITO']);
}
function inspectMfa(raw: unknown, workforce: boolean) {
  const m = obj(raw); same(m.MfaConfiguration, workforce ? 'ON' : 'OPTIONAL'); same(m.SoftwareTokenMfaConfiguration, { Enabled: true });
  for (const name of ['SmsMfaConfiguration', 'EmailMfaConfiguration'])
    if (m[name] != null) return inventoryRefuse('identity_dependency_refused');
  // AWS returns this inert default even without WEB_AUTHN in the pool's
  // AllowedFirstAuthFactors. inspectPool already requires PASSWORD alone.
  // Accept only the observed default, not relying-party or verification edits.
  if (m.WebAuthnConfiguration != null) same(m.WebAuthnConfiguration, { FactorConfiguration: 'SINGLE_FACTOR' });
}
function inspectUser(raw: unknown, subject: string, workforce: boolean, organizationId: string): string {
  const u = obj(raw); same(u.Enabled, true); same(u.UserStatus, 'CONFIRMED');
  if (!Array.isArray(u.UserAttributes) || u.UserAttributes.length > 6) return inventoryRefuse('identity_dependency_shape_refused');
  const attrs: Row = {};
  for (const v of u.UserAttributes) {
    const a = obj(v);
    if (Object.keys(a).sort().join(',') !== 'Name,Value' || typeof a.Name !== 'string' || typeof a.Value !== 'string'
      || !['sub', 'email_verified', 'custom:person_id', 'custom:organization_id', 'custom:synthetic_attested', 'custom:production_bound'].includes(a.Name)
      || Object.hasOwn(attrs, a.Name)) return inventoryRefuse('identity_dependency_shape_refused');
    attrs[a.Name] = a.Value;
  }
  same(attrs.sub, subject); same(attrs.email_verified, 'true'); same(attrs['custom:synthetic_attested'], 'true');
  if (attrs['custom:production_bound'] !== undefined) return inventoryRefuse('identity_dependency_refused');
  const person = attrs['custom:person_id']; if (typeof person !== 'string' || !uuid.test(person)) return inventoryRefuse('identity_dependency_refused');
  if (workforce) same(attrs['custom:organization_id'], organizationId);
  else if (attrs['custom:organization_id'] !== undefined && attrs['custom:organization_id'] !== organizationId) return inventoryRefuse('identity_dependency_refused');
  const mfa = set(u.UserMFASettingList ?? []);
  if (workforce) { same(mfa, ['SOFTWARE_TOKEN_MFA']); same(u.PreferredMfaSetting, 'SOFTWARE_TOKEN_MFA'); }
  else if (mfa.some(v => v !== 'SOFTWARE_TOKEN_MFA') || u.PreferredMfaSetting != null && u.PreferredMfaSetting !== 'SOFTWARE_TOKEN_MFA')
    return inventoryRefuse('identity_dependency_refused');
  return person;
}

function validateIdentityBinding(value: unknown): asserts value is InventoryQualificationTarget['identity'] {
  if (!inventoryRecord(value) || Object.keys(value).sort().join(',') !== 'consumerAudience,consumerIssuer,workforceAudience,workforceIssuer')
    return inventoryRefuse('identity_dependency_binding_refused');
  for (const issuer of [value.consumerIssuer, value.workforceIssuer])
    if (typeof issuer !== 'string' || !/^https:\/\/cognito-idp\.us-east-2\.amazonaws\.com\/us-east-2_[A-Za-z0-9]+$/.test(issuer))
      return inventoryRefuse('identity_dependency_binding_refused');
  for (const audience of [value.consumerAudience, value.workforceAudience])
    if (typeof audience !== 'string' || !/^[A-Za-z0-9]{20,128}$/.test(audience)) return inventoryRefuse('identity_dependency_binding_refused');
  if (value.consumerIssuer === value.workforceIssuer || value.consumerAudience === value.workforceAudience)
    return inventoryRefuse('identity_dependency_binding_refused');
}

/** Infrastructure-only observation before fictional subjects exist. This is
 * deliberately separate from designated-user, database and login evidence. */
export async function observeInventoryIdentityConfiguration(identity: InventoryQualificationTarget['identity'],
  transport: InventoryServiceRead = inventoryIdentityReader()) {
  const binding = structuredClone(identity); validateIdentityBinding(binding);
  const observations: Array<{ service: string; operation: string; parameters: Record<string, string | string[]>; sha256: string }> = [];
  const read: InventoryServiceRead = async (service, operation, parameters) => {
    const value = await transport(service, operation, parameters);
    observations.push({ service, operation, parameters: structuredClone(parameters), sha256: inventorySha(inventoryCanonical(value)) });
    return value;
  };
  const principal = obj(await read('sts', 'get-caller-identity', {}));
  if (principal.Account !== account || typeof principal.Arn !== 'string'
    || !/^arn:aws:sts::588966314750:assumed-role\/OrganizationAccountAccessRole\/[A-Za-z0-9+=,.@_-]+$/.test(principal.Arn))
    return inventoryRefuse('identity_dependency_principal_refused');
  for (const workforce of [false, true]) {
    const UserPoolId = (workforce ? binding.workforceIssuer : binding.consumerIssuer).split('/').at(-1)!;
    const ClientId = workforce ? binding.workforceAudience : binding.consumerAudience;
    const rawPool = await read('cognito-idp', 'describe-user-pool', { UserPoolId });
    inspectPool(rawPool, UserPoolId, workforce);
    const admin = obj(obj(obj(rawPool).UserPool).AdminCreateUserConfig);
    same(admin.AllowAdminCreateUserOnly, true);
    // Cognito's obsolete validity field can accompany the current password
    // policy. It is not signup authority and must not replace that policy.
    if (Object.keys(admin).some(k => !['AllowAdminCreateUserOnly', 'UnusedAccountValidityDays'].includes(k))
      || admin.UnusedAccountValidityDays !== undefined && admin.UnusedAccountValidityDays !== 1)
      return inventoryRefuse('identity_dependency_refused');
    inspectClient(await read('cognito-idp', 'describe-user-pool-client', { UserPoolId, ClientId }), UserPoolId, ClientId);
    inspectMfa(await read('cognito-idp', 'get-user-pool-mfa-config', { UserPoolId }), workforce);
  }
  for (const o of observations) same(inventorySha(inventoryCanonical(await transport(o.service, o.operation, o.parameters))), o.sha256);
  return { contract: 'inventory-qualification-identity-configuration/1', identityConfigurationVerified: true, privateFixtureSignupVerified: true,
    observations: observations.length, observationSha256: inventorySha(inventoryCanonical(observations)),
    designatedSyntheticSubjectsVerified: false, databaseIdentityAuthorityVerified: false, retentionServiceIdentityVerified: false,
    physicalLoginVerified: false, identityDependenciesVerified: false, liveFleetVerified: false, acceptance: false,
    humanReviewsVerified: false, phiAllowed: false, mutations: false };
}

/** Independent Cognito configuration + designated fictional accounts only.
 * Reads no tokens/passwords, emits no contact attributes or client-secret value,
 * makes no auth request, mutation or provider call. Database identity mappings,
 * organization/role/retention-service authority and real MFA/login journeys are
 * separate requirements. This component MUST NOT certify them or acceptance. */
export async function observeInventoryIdentityDependency(input: InventoryIdentityDependency,
  transport: InventoryServiceRead = inventoryIdentityReader()) {
  const b = structuredClone(input);
  if (!inventoryRecord(b) || Object.keys(b).sort().join(',') !== 'identity,organizationId,subjects' || !uuid.test(b.organizationId)
    || !inventoryRecord(b.identity) || Object.keys(b.identity).sort().join(',') !== 'consumerAudience,consumerIssuer,workforceAudience,workforceIssuer'
    || !inventoryRecord(b.subjects) || Object.keys(b.subjects).sort().join(',') !== 'consumer,foreignConsumer,workforce'
    || Object.values(b.subjects).some(s => !isInventoryCognitoSubject(s)) || new Set(Object.values(b.subjects)).size !== 3)
    return inventoryRefuse('identity_dependency_binding_refused');
  const i = b.identity; validateIdentityBinding(i);
  const observations: Array<{ service: string; operation: string; parameters: Record<string, string | string[]>; sha256: string }> = [];
  const read: InventoryServiceRead = async (service, operation, parameters) => {
    const value = await transport(service, operation, parameters);
    observations.push({ service, operation, parameters: structuredClone(parameters), sha256: inventorySha(inventoryCanonical(value)) });
    return value;
  };
  const principal = obj(await read('sts', 'get-caller-identity', {}));
  if (principal.Account !== account || typeof principal.Arn !== 'string'
    || !/^arn:aws:sts::588966314750:assumed-role\/OrganizationAccountAccessRole\/[A-Za-z0-9+=,.@_-]+$/.test(principal.Arn))
    return inventoryRefuse('identity_dependency_principal_refused');
  const people: string[] = [];
  for (const workforce of [false, true]) {
    const UserPoolId = (workforce ? i.workforceIssuer : i.consumerIssuer).split('/').at(-1)!;
    const ClientId = workforce ? i.workforceAudience : i.consumerAudience;
    inspectPool(await read('cognito-idp', 'describe-user-pool', { UserPoolId }), UserPoolId, workforce);
    inspectClient(await read('cognito-idp', 'describe-user-pool-client', { UserPoolId, ClientId }), UserPoolId, ClientId);
    inspectMfa(await read('cognito-idp', 'get-user-pool-mfa-config', { UserPoolId }), workforce);
    for (const subject of workforce ? [b.subjects.workforce] : [b.subjects.consumer, b.subjects.foreignConsumer])
      people.push(inspectUser(await read('cognito-idp', 'admin-get-user', { UserPoolId, Username: subject }), subject, workforce, b.organizationId));
  }
  if (new Set(people).size !== 3) return inventoryRefuse('identity_dependency_person_isolation_refused');
  for (const o of observations) same(inventorySha(inventoryCanonical(await transport(o.service, o.operation, o.parameters))), o.sha256);
  return { contract: 'inventory-qualification-identity-dependency/1', identityConfigurationVerified: true,
    designatedSyntheticSubjectsVerified: true, observations: observations.length, observationSha256: inventorySha(inventoryCanonical(observations)),
    // Bind DB mappings to the independently observed Cognito person attributes
    // without publishing those identifiers. This is not a caller declaration.
    personBindingsSha256: inventorySha(inventoryCanonical({ consumer: people[0], foreignConsumer: people[1], workforce: people[2] })),
    databaseIdentityAuthorityVerified: false, retentionServiceIdentityVerified: false, physicalLoginVerified: false,
    identityDependenciesVerified: false, liveFleetVerified: false, acceptance: false, humanReviewsVerified: false, phiAllowed: false, mutations: false };
}
