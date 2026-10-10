// Source release identity, not a provider/security/retention approval.
export const FULLSCRIPT_UPGRADE = Object.freeze({
  parent107: '542b101ca1729576d2b203c9c2b3d98d2d9dd897e7480ab08ff150c8eacf773c',
  parent108: '4e8e78f6d9aea14d9e622f07f5523380c17e704730c543230846c0ba5dc8e38b',
  successor111: '98ef31a24baeafb83bfd65a7832b1e4e02dbe1c71b6e78f8efdad4e0b0e62d4c',
  successorArtifact: '658fd3697bff08d7d16afba2033e6aaca439e77266aff6369730089c0b18fd7a',
  historicalTableCount: 209,
  historicalTableNames: 'c627ee381347d585bbeb1bd8d4e95a0df640de14dd1ab0989157fda4a4c2cd38',
  extensionShape: '3db36bba5d38a41b0e6a6264f956e852ad5be191af4048cc184db5862136ed0d',
});

/** Exact source successor, not an activation or provider approval. The 111
 * release above remains immutable; only this separately named contract may
 * admit the consent-copy migration on the same qualification database. */
export const FULLSCRIPT_CONSENT_SUCCESSOR = Object.freeze({
  schemaRelease: 'telehealth-consent-copy/112' as const,
  ledger: '45aec4369ec94bf6339a17e47eadba7b81e7b5195fd5be46c2903e587b709fb4',
  assembly: '6cc191355442ae2c2349cab50466979eaab0e45961a4e1547f34785294dce4b9',
  version: '20261010100000',
  name: 'production_telehealth_consent_copy',
  sqlSha256: '5d4b361c4849b900c4c6e4f95686cf77c28797584bc9e9ec1136f38bdc325e0e',
});
