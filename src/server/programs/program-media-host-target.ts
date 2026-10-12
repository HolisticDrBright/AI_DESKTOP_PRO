if (typeof window !== 'undefined') throw new Error('program media host target is server-only');
import { z } from 'zod';
import { programMediaStorageSchema } from '@/contracts/programMedia';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const role = z.string().regex(/^arn:aws:iam::588966314750:role\/[A-Za-z0-9_+=,.@/-]{1,120}$/)
  .refine(v => !/admin|root|recording|clinical|patient|voice/i.test(v));
const migration = z.object({ version: z.string().regex(/^[0-9]{14}$/), name: z.string().min(1).max(160), sha256: digest }).strict();
// BLOCKED source identities, NOT permission to register/apply them. A reviewed
// target must carry each exact identity in its actual migration ledger; an old
// ledger that merely has similarly named functions cannot qualify this host.
export const PROGRAM_MEDIA_HOST_SCHEMA_SHA256 = Object.freeze({
  'program-media-ledger.sql': '6dae2f237c13540b13cc3b7ecde877be104c35e59c7fddd9206130a62356a34d',
  'program-media-settlement.sql': '74f54bbb72539218dc6d12098a1773da572f4eb9230faae10010f69d5c95ff04',
  'program-media-native-ledger.sql': '69eb187cd22500014c1b79bf5dfdc7577e1c18376f30197eded0804f9114a6d7',
  'program-media-multipart.sql': 'a9b2a38d76f7a07569ed94342cc53a7810c6480ba6f28e0a24297265e9f70092',
  'program-media-host-authority.sql': '17f6bda07a4ec3fe541e4954abf63daf9b1ac4b4ca9149509851abf043f6892b',
});
/** Reviewed SERVER artifact only. A well-shaped artifact does not establish that
 * its reviews occurred or its resources are installed. Native DB releases and
 * current resource observations still have to match it on every request. */
export const programMediaHostTarget = z.object({
  contract: z.literal('program-media-host-target/1'), execution: z.literal('qualification'),
  account: z.literal('588966314750'), region: z.literal('us-east-2'), phiAllowed: z.literal(false),
  productionActivation: z.literal('blocked'), sourceCommit: z.string().regex(/^[a-f0-9]{40}$/), hostReviewSha256: digest,
  databaseName: z.literal('clinical_core_qualification'),
  clusterArn: z.string().regex(/^arn:aws:rds:us-east-2:588966314750:cluster:[A-Za-z0-9-]{1,63}$/),
  secretArn: z.string().regex(/^arn:aws:secretsmanager:us-east-2:588966314750:secret:[A-Za-z0-9/_+=.@!-]{1,180}$/),
  loginName: z.literal('program_media_runtime'), hostRoleArn: role, storageRoleArn: role,
  poolId: z.string().regex(/^us-east-2_[A-Za-z0-9]{1,55}$/), clientId: z.string().regex(/^[a-z0-9]{1,128}$/),
  origin: z.string().url().refine(v => { try { const u = new URL(v); return v === u.origin && u.protocol === 'https:'
    && !u.username && !u.password && !u.port; } catch { return false; } }),
  designatedWorkforce: z.array(z.object({ subject: z.string().regex(/^[A-Za-z0-9:_-]{8,128}$/),
    personId: z.string().uuid(), organizationId: z.string().uuid() }).strict()).min(1).max(20),
  migrations: z.array(migration).min(1).max(500), storage: programMediaStorageSchema,
  forbiddenBuckets: z.array(z.string().min(3).max(63)).min(1).max(100),
  forbiddenKmsKeyArns: z.array(z.string().min(20).max(180)).min(1).max(100),
  nativeEvidenceSha256: digest, multipartEvidenceSha256: digest,
  policyReview: z.object({ contract: z.literal('program-media-multipart-resource-review/1'),
    policySha256: digest, evidenceSha256: digest }).strict(),
}).strict().superRefine((t, c) => {
  const fail = () => c.addIssue({ code: 'custom', message: 'program_media_host_target_refused' });
  if (t.hostRoleArn === t.storageRoleArn || t.storage.expectedBucketOwner !== t.account || t.storage.region !== t.region
    || t.forbiddenBuckets.includes(t.storage.bucket) || t.forbiddenKmsKeyArns.includes(t.storage.kmsKeyArn)
    || new Set(t.designatedWorkforce.map(p => p.subject)).size !== t.designatedWorkforce.length
    || new Set(t.designatedWorkforce.map(p => p.personId)).size !== t.designatedWorkforce.length
    || new Set(t.migrations.map(m => m.version)).size !== t.migrations.length
    || Object.values(PROGRAM_MEDIA_HOST_SCHEMA_SHA256).some(sha => !t.migrations.some(m => m.sha256 === sha))
    || t.migrations.some((m, i) => i > 0 && m.version <= t.migrations[i - 1].version)) fail();
});
export type ProgramMediaHostTarget = z.infer<typeof programMediaHostTarget>;
