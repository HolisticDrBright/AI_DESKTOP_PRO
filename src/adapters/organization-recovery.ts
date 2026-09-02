const MISSING_ORGANIZATION_MESSAGE = "No organization selected.";

export function isMissingOrganizationMessage(message: string): boolean {
  return message.includes(MISSING_ORGANIZATION_MESSAGE);
}

/** Keep the post-recovery redirect on this application. */
export function safeOrganizationRecoveryPath(value: string | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/patients";
  return value;
}
