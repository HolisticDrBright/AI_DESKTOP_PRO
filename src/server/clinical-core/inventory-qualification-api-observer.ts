if (typeof window !== 'undefined') throw Error('inventory qualification API observation is server-only');
import { buildQualificationFoundation } from '../../../scripts/build-aws-qualification-foundation.mjs';
import { inventoryCanonical, inventoryRecord, inventoryRefuse, inventorySha, type InventoryArtifactSet } from './inventory-qualification-artifacts';
import { inventoryServiceReader, type InventoryServiceRead } from './inventory-qualification-service-observer';
import { assertInventorySnapshotConsistency, type InventoryStackSnapshot } from './inventory-qualification-stack-observer';
import { validateInventoryQualificationTarget, type InventoryQualificationTarget } from './inventory-qualification-target';

type Row = Record<string, unknown>;
const object = (v: unknown): Row => inventoryRecord(v) ? v : inventoryRefuse('shared_api_shape_refused');
const equal = (a: unknown, b: unknown) => {
  if (inventoryCanonical(a) !== inventoryCanonical(b)) inventoryRefuse('shared_api_configuration_refused');
};
function allowed(row: Row, names: string[]) {
  if (Object.keys(row).some(k => !names.includes(k))) inventoryRefuse('shared_api_property_coverage_refused');
}
function empty(v: unknown) { equal(v ?? {}, {}); }
function tags(actual: unknown, expected: unknown, stackId: string, logicalId: string, stackName: string) {
  const t = { ...object(actual) };
  for (const [name, value] of Object.entries({ 'aws:cloudformation:stack-id': stackId,
    'aws:cloudformation:stack-name': stackName, 'aws:cloudformation:logical-id': logicalId })) {
    if (Object.hasOwn(t, name)) { equal(t[name], value); delete t[name]; }
  }
  equal(t, expected);
}
function collection(value: unknown, key: string): Row[] {
  const output = object(value); allowed(output, ['Items', 'NextToken']);
  if (output.NextToken !== undefined || !Array.isArray(output.Items) || output.Items.length > 512) return inventoryRefuse('shared_api_inventory_refused');
  const rows = output.Items.map(object), ids = rows.map(r => r[key]);
  if (ids.some(id => typeof id !== 'string' || !id || id.length > 256) || new Set(ids).size !== ids.length) return inventoryRefuse('shared_api_inventory_refused');
  return rows.sort((a, b) => String(a[key]).localeCompare(String(b[key])));
}

/** Whole API inventory, not just the known routes. Declaration snapshots must
 * come from the enclosing independent stack observer, not a caller assertion.
 * This component does not attest STS, foundation ownership, identities, code,
 * database, runtime acceptance, human reviews or PHI activation. */
export async function observeInventorySharedApi(supplied: InventoryQualificationTarget, suppliedSnapshots: Record<string, InventoryStackSnapshot>,
  foundationStackId: string, suppliedArtifacts: InventoryArtifactSet, transport: InventoryServiceRead = inventoryServiceReader()) {
  const artifacts = structuredClone(suppliedArtifacts), target = validateInventoryQualificationTarget(supplied, artifacts),
    snapshots = structuredClone(suppliedSnapshots), base = target.target;
  const prefix = `arn:aws:cloudformation:us-east-2:588966314750:stack/${base.foundationStackName}/`;
  if (base.awsAccountId !== '588966314750' || base.awsRegion !== 'us-east-2' || base.apiOrigin !== `https://${base.apiId}.execute-api.us-east-2.amazonaws.com`
    || !/^[a-z0-9]{10}$/.test(base.apiId) || !foundationStackId.startsWith(prefix) || foundationStackId.length <= prefix.length
    || target.candidates.length !== 12 || new Set(target.candidates.map(c => c.candidate)).size !== 12) return inventoryRefuse('shared_api_binding_refused');
  equal(Object.keys(snapshots).sort(), target.candidates.map(c => c.candidate).sort());
  const groups = { Route: new Map<string, Row>(), Integration: new Map<string, Row>(), Authorizer: new Map<string, Row>() };
  for (const c of target.candidates) {
    const s = snapshots[c.candidate], stackPrefix = `arn:aws:cloudformation:us-east-2:588966314750:stack/${c.stackName}/`;
    if (!s.stackId.startsWith(stackPrefix) || s.stackId.length <= stackPrefix.length) return inventoryRefuse('shared_api_binding_refused');
    assertInventorySnapshotConsistency(s, c, artifacts.candidates.find(a => a.candidate === c.candidate)!, 'shared_api_binding_refused');
    for (const r of s.resources) {
      if (!r.type.startsWith('AWS::ApiGatewayV2::')) continue;
      const suffix = r.type.split('::').at(-1);
      if (suffix !== 'Route' && suffix !== 'Integration' && suffix !== 'Authorizer') return inventoryRefuse('shared_api_inventory_refused');
      if (r.properties.ApiId !== base.apiId || groups[suffix].has(r.physicalId)) return inventoryRefuse('shared_api_inventory_refused');
      const { ApiId: _apiId, ...properties } = r.properties;
      groups[suffix].set(r.physicalId, properties);
    }
  }
  const routeKeys = [...groups.Route.values()].map(r => r.RouteKey);
  if (!routeKeys.length || new Set(routeKeys).size !== routeKeys.length || !groups.Integration.size || !groups.Authorizer.size) return inventoryRefuse('shared_api_inventory_refused');
  for (const r of groups.Route.values()) {
    if (typeof r.Target !== 'string' || !/^integrations\/[A-Za-z0-9-]+$/.test(r.Target)
      || !groups.Integration.has(r.Target.slice(13)) || r.AuthorizationType !== 'JWT'
      || typeof r.AuthorizerId !== 'string' || !groups.Authorizer.has(r.AuthorizerId)) return inventoryRefuse('shared_api_reference_refused');
  }
  // Voice's external authorizer must be one of this fleet's independently
  // observed consumer authorizers, not a new unmanaged identity boundary.
  for (const c of target.candidates) if (c.parameters.ConsumerJwtAuthorizerId !== undefined) {
    const a = groups.Authorizer.get(c.parameters.ConsumerJwtAuthorizerId);
    if (!a || a.AuthorizerType !== 'JWT') return inventoryRefuse('shared_api_reference_refused');
    equal(a.JwtConfiguration, { Audience: [target.identity.consumerAudience], Issuer: target.identity.consumerIssuer });
  }
  const observations: Array<{ operation: string; value: unknown }> = [];
  const read = async (operation: string) => {
    const raw = await transport('apigatewayv2', operation, { ApiId: base.apiId });
    const value = operation === 'get-api' ? object(raw) : { Items: collection(raw,
      operation === 'get-stages' ? 'StageName' : operation === 'get-routes' ? 'RouteId' : operation === 'get-integrations' ? 'IntegrationId' : 'AuthorizerId') };
    observations.push({ operation, value: structuredClone(value) }); return value;
  };
  const foundation = buildQualificationFoundation(), apiProps = foundation.Resources.Api.Properties, stageProps = foundation.Resources.Stage.Properties;
  const api = object(await read('get-api'));
  allowed(api, ['ApiId', 'ApiEndpoint', 'ApiKeySelectionExpression', 'CreatedDate', 'DisableExecuteApiEndpoint', 'IpAddressType', 'Name',
    'ProtocolType', 'RouteSelectionExpression', 'Tags', 'ApiGatewayManaged', 'DisableSchemaValidation']);
  equal(api.ApiId, base.apiId); equal(api.ApiEndpoint, base.apiOrigin); equal(api.Name, apiProps.Name); equal(api.ProtocolType, 'HTTP');
  equal(api.RouteSelectionExpression, '$request.method $request.path'); equal(api.ApiKeySelectionExpression, '$request.header.x-api-key');
  equal(api.DisableExecuteApiEndpoint ?? false, false); equal(api.IpAddressType ?? 'ipv4', 'ipv4');
  equal(api.ApiGatewayManaged ?? false, false); equal(api.DisableSchemaValidation ?? false, false);
  tags(api.Tags, apiProps.Tags, foundationStackId, 'Api', base.foundationStackName);
  const stages = collection(await read('get-stages'), 'StageName');
  if (stages.length !== 1) return inventoryRefuse('shared_api_stage_refused');
  const stage = stages[0];
  allowed(stage, ['StageName', 'AccessLogSettings', 'AutoDeploy', 'CreatedDate', 'DefaultRouteSettings', 'DeploymentId',
    'LastDeploymentStatusMessage', 'LastUpdatedDate', 'RouteSettings', 'StageVariables', 'Tags', 'ApiGatewayManaged']);
  equal(stage.StageName, '$default'); equal(stage.AutoDeploy, true); equal(stage.ApiGatewayManaged ?? false, false);
  equal(stage.DefaultRouteSettings, stageProps.DefaultRouteSettings); empty(stage.RouteSettings); empty(stage.StageVariables);
  equal(stage.AccessLogSettings, { DestinationArn: `arn:aws:logs:us-east-2:588966314750:log-group:/aws/apigateway/qualification/${base.apiId}`,
    Format: stageProps.AccessLogSettings.Format });
  if (typeof stage.DeploymentId !== 'string' || !/^[A-Za-z0-9]{1,128}$/.test(stage.DeploymentId)
    || stage.LastDeploymentStatusMessage !== `Successfully deployed stage with deployment ID '${stage.DeploymentId}'`) return inventoryRefuse('shared_api_stage_refused');
  tags(stage.Tags, stageProps.Tags, foundationStackId, 'Stage', base.foundationStackName);
  for (const [suffix, group] of Object.entries(groups)) {
    const operation = `get-${suffix.toLowerCase()}s`, id = `${suffix}Id`, rows = collection(await read(operation), id);
    equal(rows.map(r => r[id]).sort(), [...group.keys()].sort());
    for (const r of rows) {
      const expected = group.get(String(r[id]))!;
      const fields = suffix === 'Route' ? ['RouteId', 'RouteKey', 'AuthorizationType', 'AuthorizerId', 'Target', 'ApiKeyRequired', 'AuthorizationScopes', 'ApiGatewayManaged']
        : suffix === 'Integration' ? ['IntegrationId', 'IntegrationType', 'IntegrationUri', 'PayloadFormatVersion', 'TimeoutInMillis',
          'ConnectionType', 'CredentialsArn', 'RequestParameters', 'ResponseParameters', 'IntegrationMethod', 'ApiGatewayManaged']
          : ['AuthorizerId', 'Name', 'AuthorizerType', 'IdentitySource', 'JwtConfiguration'];
      allowed(r, fields);
      for (const [name, value] of Object.entries(expected)) equal(r[name] ?? null, value);
      if (suffix === 'Route') { equal(r.ApiKeyRequired ?? false, false); equal(r.AuthorizationScopes ?? [], []); equal(r.ApiGatewayManaged ?? false, false); }
      if (suffix === 'Integration') {
        equal(r.ConnectionType ?? 'INTERNET', 'INTERNET'); equal(r.CredentialsArn ?? null, null);
        empty(r.RequestParameters); empty(r.ResponseParameters); equal(r.IntegrationMethod ?? 'POST', 'POST'); equal(r.ApiGatewayManaged ?? false, false);
      }
    }
  }
  for (const observation of observations) {
    const raw = await transport('apigatewayv2', observation.operation, { ApiId: base.apiId });
    const current = observation.operation === 'get-api' ? object(raw) : { Items: collection(raw,
      observation.operation === 'get-stages' ? 'StageName' : observation.operation === 'get-routes' ? 'RouteId'
        : observation.operation === 'get-integrations' ? 'IntegrationId' : 'AuthorizerId') };
    if (inventoryCanonical(current) !== inventoryCanonical(observation.value)) return inventoryRefuse('shared_api_observation_changed');
  }
  return { contract: 'inventory-qualification-shared-api-observation/1', sharedApiInventoryVerified: true,
    apiId: base.apiId, routes: groups.Route.size, integrations: groups.Integration.size, authorizers: groups.Authorizer.size,
    observations: observations.length, observationSha256: inventorySha(inventoryCanonical(observations)),
    sourcePrincipalFoundationVerified: false, wholeLedgerVerified: false, uploadedVersionsVerified: false,
    acceptance: false, humanReviewsVerified: false, phiAllowed: false, mutations: false };
}
