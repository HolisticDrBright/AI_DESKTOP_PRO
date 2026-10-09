if (typeof window !== 'undefined') throw new Error('inventory qualification profile is server-only');
import { ADOPTED_INVENTORY_UPGRADE } from './adopted-plan-inventory-schema-upgrade';
import { resolveQualificationExecution } from './qualification-execution';

export const INVENTORY_QUALIFICATION_PROFILE = 'adopted-plan-inventory-qualification/1' as const;
export type InventoryQualificationBuild = {
  sourceCommit: string; sourceClean: boolean; migrationCount: 107;
  migrationReleaseSha256: string; qualificationProfile: typeof INVENTORY_QUALIFICATION_PROFILE;
};
/** A distinct synthetic execution contract, not an expansion of the historical
 * 106 profile or production activation. Reviews are supplied, never authored here. */
export function assertInventoryQualificationBinding(e: Record<string, string | undefined>, b: InventoryQualificationBuild,
  activationKey: string) {
  if (b.qualificationProfile !== INVENTORY_QUALIFICATION_PROFILE || b.migrationCount !== 107
    || b.migrationReleaseSha256 !== ADOPTED_INVENTORY_UPGRADE.to || !/^[a-f0-9]{40}$/.test(b.sourceCommit)
    || e.INVENTORY_QUALIFICATION_PROFILE !== INVENTORY_QUALIFICATION_PROFILE
    || e.SOURCE_COMMIT !== b.sourceCommit || e.MIGRATION_RELEASE_SHA256 !== ADOPTED_INVENTORY_UPGRADE.to
    || e.PHI_ALLOWED !== 'false' || e[activationKey] !== 'blocked' || e.AWS_REGION !== 'us-east-2'
    || e.DEPLOYMENT_ACCOUNT_ID !== '588966314750' || e.CLINICAL_DATABASE_NAME !== 'clinical_core_qualification'
    || !/^arn:aws:rds:us-east-2:588966314750:cluster:[A-Za-z0-9-]{1,63}$/.test(e.CLINICAL_DATABASE_CLUSTER_ARN ?? '')
    || !/^arn:aws:secretsmanager:us-east-2:588966314750:secret:[A-Za-z0-9/_+=.@!-]+$/.test(e.CLINICAL_DATABASE_SECRET_ARN ?? '')
    || !['disabled', 'enabled'].includes(e.QUALIFICATION_EXECUTION ?? '')) throw new Error('inventory_qualification_binding_refused');
  const q = resolveQualificationExecution(e, 'blocked');
  if (q && (b.sourceClean !== true || q.accountId !== '588966314750' || q.databaseName !== 'clinical_core_qualification')) {
    throw new Error('inventory_qualification_binding_refused');
  }
}
