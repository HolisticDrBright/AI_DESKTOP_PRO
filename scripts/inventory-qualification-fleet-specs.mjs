// Ten ordinary candidates, joined by the two separately compiled care candidates.
// Workers are never counted as
// successful API refusals. The lab API artifact must also export cleanup.
const fn = (id, file, source, activation, kind = 'api', exportName = 'handler') => ({ id, file, source, activation, kind, exportName });
export const INVENTORY_FLEET_SPECS = [
  { name: 'personal-storage', builder: 'build-aws-personal-storage.mjs', functions: [fn('Function', 'index.js', 'owned-consumer-api-lambda.ts', 'PERSONAL_STORAGE_ACTIVATION')] },
  { name: 'privacy-operations', builder: 'build-aws-privacy-operations.mjs', functions: [
    fn('Function', 'index.js', 'privacy-operations-lambda.ts', 'PRIVACY_OPERATIONS_ACTIVATION'),
    fn('RetentionSweep', 'retention-sweep.js', 'privacy-retention-sweep-lambda.ts', 'PRIVACY_OPERATIONS_ACTIVATION', 'worker')] },
  { name: 'owned-lab', builder: 'build-aws-owned-lab.mjs', functions: [
    fn('LabApiFunction', 'index.js', 'owned-lab-api-lambda.ts', 'PERSONAL_LAB_ACTIVATION'),
    fn('LabCleanupFunction', 'index.js', 'owned-lab-api-lambda.ts', 'PERSONAL_LAB_ACTIVATION', 'worker', 'cleanup'),
    fn('LabWorkerFunction', 'worker.js', 'owned-lab-worker-lambda.ts', 'PERSONAL_LAB_ACTIVATION', 'worker')] },
  { name: 'owned-voice', builder: 'build-aws-owned-voice.mjs', functions: [fn('VoiceJobFunction', 'index.js', 'owned-voice-api-lambda.ts', 'PERSONAL_VOICE_ACTIVATION')] },
  ...['authority', 'capture', 'transcription', 'drafting', 'cleanup-review', 'cleanup-execution'].map(mode => ({
    name: `recording-${mode}`, builder: 'build-aws-recording-authority.mjs', flags: mode === 'authority' ? [] : [`--${mode}`],
    runtime: mode === 'authority' ? undefined : `recording-${mode}-runtime.js`,
    functions: [fn('Function', 'index.js', `recording-${mode}-lambda.ts`, `RECORDING_${mode.replaceAll('-', '_').toUpperCase()}_ACTIVATION`)],
  })),
];
