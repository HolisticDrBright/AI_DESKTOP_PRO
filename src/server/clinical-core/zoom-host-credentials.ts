if (typeof window !== 'undefined') throw Error('zoom host credentials are server-only');
import { GetSecretValueCommand, SecretsManagerClient, type GetSecretValueCommandOutput } from '@aws-sdk/client-secrets-manager';
import type { ClinicalCoreDatabase } from './database';
import type { ProductionClinicalRequestContext } from './aws-identity-consent';
import { createZoomHostRegistry, parseZoomHostBindingResponse, type ZoomHostBinding, type ZoomHostFunctionPin, type ZoomHostRegistryTarget } from './zoom-host-registry';
import { parseZoomCredentialSnapshot, ZoomCredentialRefused, zoomCredentialsForRequest, type ZoomCredentialSnapshot } from './zoom-credential-snapshot';
import { recoveryAwait } from './appointment-provider-recovery';

type SecretReader = {
  send(command: GetSecretValueCommand, options: { abortSignal: AbortSignal }): Promise<GetSecretValueCommandOutput>;
};
type ResolverOptions = Readonly<{
  database: ClinicalCoreDatabase;
  compiledPins: readonly ZoomHostFunctionPin[];
  compiledTarget: ZoomHostRegistryTarget;
  /** Deployment-reviewed exact secret ARNs, not caller input or IAM permission.
   * The eventual deployment must also pin the actual IAM grants. */
  allowedSecretArns: readonly string[];
  secretReader?: SecretReader;
}>;
const bindingKeys = ['bindingId','organizationId','appointmentId','patientRecordId','practitionerPersonId','appointmentVersion',
  'scheduledStart','scheduledEnd','intentId','releaseId','releaseRevision','configurationSha256'] as const;
function matches(a: ZoomHostBinding, b: ZoomHostBinding) {
  return bindingKeys.every(key => a[key] === b[key]);
}
function matchesCredentials(c: ZoomCredentialSnapshot, binding: ZoomHostBinding) {
  const config = binding.configuration;
  if (c.accountId !== config.zoomAccountId || c.clientId !== config.clientId || c.userId !== config.zoomHostId || c.sdkKey !== config.sdkAppKey)
    throw new ZoomCredentialRefused();
}

/** Unreleased source composition. The caller must already hold an admitted,
 * durable visit binding and an authenticated workforce context. This function
 * never binds a new host, accepts cleanup metadata as processing authority,
 * falls back to a global/AWSCURRENT credential or calls Zoom. It is not the
 * still-required HTTP/MFA, full release/schema, consent or provider boundary. */
export function createZoomHostCredentialResolver(options: ResolverOptions) {
  const target = Object.freeze({ ...options.compiledTarget });
  const registry = createZoomHostRegistry(options.database, options.compiledPins, target);
  const arnPattern = new RegExp('^arn:aws:secretsmanager:us-east-2:' + target.awsAccountId + ':secret:[A-Za-z0-9/_+=.@-]{1,512}-[A-Za-z0-9]{6}$');
  if (!Array.isArray(options.allowedSecretArns) || options.allowedSecretArns.length < 1 || options.allowedSecretArns.length > 100
    || new Set(options.allowedSecretArns).size !== options.allowedSecretArns.length
    || options.allowedSecretArns.some(arn => typeof arn !== 'string' || !arnPattern.test(arn))) throw new ZoomCredentialRefused();
  const allowed = new Set(options.allowedSecretArns);
  const secrets: SecretReader = options.secretReader ?? new SecretsManagerClient({ region: target.region, maxAttempts: 1 });
  return async (context: ProductionClinicalRequestContext, originalBinding: ZoomHostBinding, callerSignal: AbortSignal): Promise<ZoomCredentialSnapshot> => {
    try {
      if (!callerSignal || typeof callerSignal.addEventListener !== 'function' || callerSignal.aborted
        || !originalBinding || (originalBinding.purpose !== undefined && originalBinding.purpose !== 'new_processing')) throw new ZoomCredentialRefused();
      // Snapshot caller-owned objects before any await. Strict parsing also
      // refuses substituted configuration, unknown fields and target changes.
      const actor = Object.freeze({ ...context });
      const original = parseZoomHostBindingResponse(originalBinding, actor, target, originalBinding.appointmentId,
        originalBinding.intentId, originalBinding.purpose);
      const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(20_000)]);
      const read = async () => {
        const current = await recoveryAwait(signal, () => registry(actor, {
          action: 'read', appointmentId: original.appointmentId, purpose: 'new_processing',
        }));
        if (!matches(original, current) || !allowed.has(current.configuration.secretArn)) throw new ZoomCredentialRefused();
        return current;
      };
      const before = await read();
      const config = before.configuration;
      // The request-local cache key includes VersionId; a failed version read
      // remains refused, never retried against a changed secret in this request.
      const cacheKey = 'versioned:' + config.secretArn + ':' + config.secretVersionId;
      const credentials = await recoveryAwait(signal, () => zoomCredentialsForRequest(cacheKey, async () => {
        const result = await recoveryAwait(signal, () => secrets.send(new GetSecretValueCommand({
          SecretId: config.secretArn, VersionId: config.secretVersionId,
        }), { abortSignal: signal }));
        if (result.$metadata.httpStatusCode !== 200 || result.ARN !== config.secretArn
          || result.VersionId !== config.secretVersionId || result.SecretBinary !== undefined)
          throw new ZoomCredentialRefused();
        matchesCredentials(parseZoomCredentialSnapshot(result.SecretString, true), before);
        return result.SecretString;
      }, true));
      matchesCredentials(credentials, before);
      // A secret read/cache hit cannot renew a rotated or revoked release.
      // This second transaction detects authority loss during the read. It is
      // not an atomic lock on the provider or a promise of remote cancellation.
      await read();
      if (signal.aborted) throw new ZoomCredentialRefused();
      return credentials;
    } catch { throw new ZoomCredentialRefused(); }
  };
}
