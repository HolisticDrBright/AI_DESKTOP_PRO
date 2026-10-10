type Resource = { Type: string; Condition: string; DeletionPolicy: string; UpdateReplacePolicy: string;
  Properties: { [key: string]: unknown; Schema: Array<{ Name: string; [key: string]: unknown }> } };
export const IDENTITY_ACCOUNT: string;
export const IDENTITY_REGION: string;
export function buildInventoryQualificationIdentities(...options: unknown[]): {
  Resources: Record<string, Resource>;
};
