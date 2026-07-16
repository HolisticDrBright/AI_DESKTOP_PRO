"use client";

import { useState } from "react";
import { LogOut } from "lucide-react";

/** Small sign-out control for the Settings data-source panel (live mode). */
export function SignOutButton() {
  const [pending, setPending] = useState(false);
  return (
    <button
      onClick={async () => {
        setPending(true);
        try {
          await fetch("/api/auth/logout", { method: "POST" });
          window.location.reload();
        } finally {
          setPending(false);
        }
      }}
      disabled={pending}
      className="flex h-7 cursor-pointer items-center gap-[5px] rounded-lg border border-line bg-card px-[10px] text-[11.5px] font-semibold text-body hover:border-line-hover focus-visible:outline-2 focus-visible:outline-action disabled:opacity-50"
    >
      <LogOut size={12} strokeWidth={2} aria-hidden />
      Sign out
    </button>
  );
}
