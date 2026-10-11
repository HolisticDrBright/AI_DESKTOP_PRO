// Independently compiled from the same immutable 111 SQL on two local engines.
// These whole projections include every column/NOT NULL/default/constraint,
// index, policy and trigger. No target-observed digest or normalization is used.
export const FULLSCRIPT_EXTENSION_SHAPE_RELEASE = Object.freeze({
  '17.7': '9bdcb1ffc4a0f9a28c631d2545c4c1fd276aa53c4edf186b3d4d7dbcd8e28ee5',
  '18.3': '3db36bba5d38a41b0e6a6264f956e852ad5be191af4048cc184db5862136ed0d',
});

export function fullscriptExtensionShapeForVersion(version: unknown): string | undefined {
  if (version !== '17.7' && version !== '18.3') return undefined;
  return FULLSCRIPT_EXTENSION_SHAPE_RELEASE[version];
}
