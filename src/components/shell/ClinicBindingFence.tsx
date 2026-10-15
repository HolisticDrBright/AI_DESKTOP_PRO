"use client";

import { installClinicBindingFence } from "@/lib/clinic-binding";

// Installed when the client bundle loads, before any component effect can call a live route.
installClinicBindingFence();

/** Mounts the stale-tab clinic fence for this tab. Renders nothing. */
export function ClinicBindingFence() {
  return null;
}
