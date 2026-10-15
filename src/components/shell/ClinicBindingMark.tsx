"use client";

import { setTabClinicBinding } from "@/lib/clinic-binding";

/**
 * Records, for this tab, the clinic binding a server-rendered page was produced under. It runs during render, so the
 * binding is in place before any effect on the page calls a live route. Renders nothing.
 */
export function ClinicBindingMark({ token }: { token: string | null }) {
  setTabClinicBinding(token);
  return null;
}
