// Invalidation only: never carries identity, credentials or clinical data.
const KEY = 'alp-workforce-session-change';
export function announceWorkforceSessionChange() {
  window.dispatchEvent(new Event(KEY));
  try { localStorage.setItem(KEY, crypto.randomUUID()); } catch { /* Server authority still rechecks every request. */ }
}
export function onWorkforceSessionChange(invalidate: () => void) {
  const storage = (event: StorageEvent) => { if (event.key === KEY) invalidate(); };
  window.addEventListener(KEY, invalidate);
  window.addEventListener('storage', storage);
  return () => { window.removeEventListener(KEY, invalidate); window.removeEventListener('storage', storage); };
}
