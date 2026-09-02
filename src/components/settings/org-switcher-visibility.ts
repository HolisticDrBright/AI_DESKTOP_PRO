export function shouldShowOrgSwitcher(
  organizationCount: number,
  activeOrgId: string | null,
): boolean {
  return organizationCount > 1 || (organizationCount === 1 && !activeOrgId);
}
