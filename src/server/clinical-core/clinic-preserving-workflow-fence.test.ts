import { beforeAll, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { executeClinicPreservingWorkflow, clinicWorkflowSha256, type ClinicWorkflowBinding, type ClinicWorkflowPorts } from './clinic-preserving-workflow';
import { CLINIC_NATIVE_SOURCE_RECEIPT_SHA256 } from '../../../scripts/clinic-preserving-transition.mjs';

let artifact: unknown;
const source = JSON.parse(readFileSync('infra/aws-clinical-core/source-receipts/clinic-native-source-52d1742.json', 'utf8'));
beforeAll(() => { artifact = JSON.parse(execFileSync(process.execPath, ['scripts/build-clinic-record-privacy-candidate.mjs', '--json'],
  { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 60000, windowsHide: true })); }, 60000);
it.each([undefined, { contract: 'clinic-preserving-workflow-result/1', operatorAcceptance: true }])
  ('refuses a fence that substitutes %j without executing the guarded workflow', async replacement => {
    let invoked = 0;
    const unexpected = async (): Promise<never> => { invoked++; throw Error('unexpected workflow callback'); };
    const binding: ClinicWorkflowBinding = { contract: 'clinic-preserving-workflow-binding/1', execution: 'injected_protocol_qualification',
      sourceCommit: 'a'.repeat(40), operatorSha256: 'b'.repeat(64), sourceArtifactSha256: clinicWorkflowSha256(artifact),
      independentReceiptSha256: CLINIC_NATIVE_SOURCE_RECEIPT_SHA256, targetSha256: 'c'.repeat(64), profileSha256: 'd'.repeat(64), phiAllowed: false, activation: 'blocked' };
    const ports: ClinicWorkflowPorts = { withFence: async () => replacement as never, guard: unexpected,
      observe: unexpected, rehearse: unexpected, forward: unexpected, createCustody: unexpected, openRecovery: unexpected };
    await expect(executeClinicPreservingWorkflow('upgrade', binding, artifact, source, ports)).rejects.toMatchObject({ category: 'custody_refused' });
    expect(invoked).toBe(0);
  });
