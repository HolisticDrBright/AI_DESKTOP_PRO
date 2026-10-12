import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The owned (production and qualification) lab worker classifies personal documents. Its template
 * asserts LabRangeMode=reviewed_release (scripts/build-aws-owned-lab.mjs), but the shared worker
 * treats an UNSET mode as the synthetic fixture: hard-coded "functional" ranges for a synthetic adult,
 * applied to anyone regardless of age, sex or pregnancy. Before this fix the entry point did not
 * check, so a function deployed without the parameter (or with it removed) classified real
 * documents against fixture ranges. The entry now refuses before it touches the adapter or a job.
 */
const m = vi.hoisted(() => ({ worker: vi.fn(async () => ({ completed: true })), adapter: vi.fn(() => ({})), policy: vi.fn(() => ({ policy: { verify: vi.fn() } })) }));
vi.mock('./aws-lab-analysis-worker', () => ({ createAwsLabAnalysisWorker: m.worker }));
vi.mock('./owned-lab-api-lambda', () => ({ ownedLabAdapterFromEnv: m.adapter }));
vi.mock('./owned-lab-authorization', () => ({ createOwnedLabAuthorization: m.policy }));
vi.mock('./owned-lab-publication', () => ({ publishLabResult: vi.fn() }));
import { handler } from './owned-lab-worker-lambda';

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('LAB_OBJECT_PREFIX', 'personal-labs');
  vi.stubEnv('PHI_ALLOWED', 'true');
  vi.stubEnv('PERSONAL_LAB_ACTIVATION', 'approved');
});
afterEach(() => vi.unstubAllEnvs());

describe('the owned lab worker entry', () => {
  it.each([['unset', undefined], ['the synthetic fixture', 'synthetic_fixture'], ['anything else', 'functional']])('refuses with the range mode %s, before any job is read', async (_name, mode) => {
    if (mode === undefined) vi.stubEnv('LAB_RANGE_MODE', ''); else vi.stubEnv('LAB_RANGE_MODE', mode);
    await expect(handler({ jobId: '22222222-2222-4222-8222-222222222222', pass: 0 })).rejects.toThrow('lab_range_release_required');
    expect(m.worker).not.toHaveBeenCalled();
    expect(m.adapter).not.toHaveBeenCalled();
  });
  it('runs only against a signed reviewed range release', async () => {
    vi.stubEnv('LAB_RANGE_MODE', 'reviewed_release');
    await expect(handler({ jobId: '22222222-2222-4222-8222-222222222222', pass: 0 })).resolves.toMatchObject({ completed: true });
    expect(m.worker).toHaveBeenCalledOnce();
  });
});
