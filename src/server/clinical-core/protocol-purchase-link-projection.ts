/** Education-only consumer reads retain the saved protocol but never return
 * legacy purchase destinations. This is a response projection, not erasure. */
export function withholdProtocolPurchaseLinks(payload: Record<string, unknown>): Record<string, unknown> {
  return project(payload) as Record<string, unknown>;
}

function project(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(/(?:https?:\/\/|www\.)[^\s<>"')\]]+/gi, "[link withheld]");
  }
  if (Array.isArray(value)) {
    let changed = false;
    const projected = value.map((item) => {
      const next = project(item);
      if (next !== item) changed = true;
      return next;
    });
    return changed ? projected : value;
  }
  if (value === null || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  let changed = false;
  const projected: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(source)) {
    if (/(?:url|uri|link|href)$/i.test(key)) {
      changed = true;
      continue;
    }
    const next = project(item);
    if (next !== item) changed = true;
    projected[key] = next;
  }
  return changed ? projected : value;
}
