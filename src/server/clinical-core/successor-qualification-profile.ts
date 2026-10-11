if (typeof window !== 'undefined') throw Error('successor qualification profile is server-only');
import { SUCCESSOR_QUALIFICATION_RELEASE as release } from '../../../scripts/successor-qualification-release.mjs';
import { resolveQualificationExecution } from './qualification-execution';

export type SuccessorQualificationBuild = typeof release & {
  sourceCommit: string; sourceClean: boolean; sourceInputSha256: string;
};
type Environment = Record<string, string | undefined>;
const digest = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v) && v !== '0'.repeat(64);

/** Separate, compiled successor. This cannot admit historical builds, production,
 * an operator/master credential or an arbitrary matching-count artifact. */
export function assertSuccessorQualificationBinding(e: Environment, b: SuccessorQualificationBuild, activationKey: string,
  credential: 'api' | 'fullscript-worker' = 'api') {
  if (!b || b.migrationCount !== release.migrationCount || b.migrationReleaseSha256 !== release.migrationReleaseSha256
    || b.migrationAssemblySha256 !== release.migrationAssemblySha256 || b.qualificationProfile !== release.qualificationProfile
    || b.sourceClean !== true || typeof b.sourceCommit !== 'string' || !/^[a-f0-9]{40}$/.test(b.sourceCommit)
    || !digest(b.sourceInputSha256) || e.SUCCESSOR_QUALIFICATION_PROFILE !== release.qualificationProfile
    || e.INVENTORY_QUALIFICATION_PROFILE !== undefined || e.SOURCE_COMMIT !== b.sourceCommit
    || e.SOURCE_INPUT_SHA256 !== b.sourceInputSha256 || e.MIGRATION_RELEASE_SHA256 !== release.migrationReleaseSha256
    || e.MIGRATION_ASSEMBLY_SHA256 !== release.migrationAssemblySha256
    || e.PHI_ALLOWED !== 'false' || e[activationKey] !== 'blocked' || e.AWS_REGION !== 'us-east-2'
    || e.DEPLOYMENT_ACCOUNT_ID !== '588966314750' || e.CLINICAL_DATABASE_NAME !== 'clinical_core_qualification'
    || !/^arn:aws:rds:us-east-2:588966314750:cluster:[A-Za-z0-9-]{1,63}$/.test(e.CLINICAL_DATABASE_CLUSTER_ARN ?? '')
    || !['api', 'fullscript-worker'].includes(credential)
    || !new RegExp(`^arn:aws:secretsmanager:us-east-2:588966314750:secret:alp/qualification/${credential === 'api' ? 'runtime-api' : 'fullscript-worker'}-[A-Za-z0-9-]+$`)
      .test(e.CLINICAL_DATABASE_SECRET_ARN ?? '')
    || !['disabled', 'enabled'].includes(e.QUALIFICATION_EXECUTION ?? '')) throw Error('successor_qualification_binding_refused');
  const q = resolveQualificationExecution(e, 'blocked');
  if (q && (q.accountId !== '588966314750' || q.databaseName !== 'clinical_core_qualification'))
    throw Error('successor_qualification_binding_refused');
}

/** Parent imports happen only after exact admission, and are checked again after
 * await. This declares no hosted/role/rotation/policy acceptance. */
export function createSuccessorQualificationEnvelope(environment: () => Environment, supplied: SuccessorQualificationBuild,
  activationKey: string, kind: 'api' | 'worker', load: () => Promise<(...args: unknown[]) => unknown>,
  credential: 'api' | 'fullscript-worker' = 'api') {
  // AWS changes this reserved tracing field per invocation. It carries no
  // deployment authority. Every other field, including new keys, stays bound.
  // https://docs.aws.amazon.com/lambda/latest/dg/configuration-envvars.html
  const stableEnvironment = () => Object.fromEntries(Object.entries(environment()).filter(([name]) => name !== '_X_AMZN_TRACE_ID'));
  const build = structuredClone(supplied), captured = stableEnvironment();
  let parent: ReturnType<typeof load> | undefined;
  const validate = () => {
    const e = stableEnvironment(), names = Object.keys(e);
    if (names.length !== Object.keys(captured).length || names.some(k => e[k] !== captured[k]))
      throw Error('successor_qualification_environment_changed');
    assertSuccessorQualificationBinding(e, build, activationKey, credential);
    if (e.QUALIFICATION_EXECUTION !== 'enabled') throw Error('successor_qualification_not_enabled');
  };
  return async (...args: unknown[]) => {
    try {
      validate(); parent ??= load(); const invoke = await parent; validate();
      if (typeof invoke !== 'function') throw Error('successor_qualification_entry_missing');
      return await invoke(...args);
    } catch {
      if (kind === 'worker') throw Error('successor_qualification_unavailable');
      return { statusCode: 503, headers: { 'content-type': 'application/json', 'cache-control': 'no-store',
        'x-content-type-options': 'nosniff' }, body: '{"error":"service_unavailable"}' };
    }
  };
}
