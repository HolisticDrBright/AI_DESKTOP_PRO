/** Object namespace for lab documents and worker artifacts. The synthetic
 * default is unchanged. The production-owned candidate sets a separate
 * namespace so IAM scopes, cleanup and inventory never cross between synthetic
 * fixtures and personal health documents. Any other value fails closed. */
export const LAB_OBJECT_PREFIXES=['synthetic-labs','personal-labs'] as const;
export type LabObjectPrefix=typeof LAB_OBJECT_PREFIXES[number];
export function labObjectPrefix(env:Record<string,string|undefined>=process.env):LabObjectPrefix{
  const value=env.LAB_OBJECT_PREFIX??'synthetic-labs';
  if(!(LAB_OBJECT_PREFIXES as readonly string[]).includes(value))throw new Error('lab_object_prefix_invalid');
  return value as LabObjectPrefix;
}
