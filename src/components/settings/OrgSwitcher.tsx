"use client";

import { useState } from "react";

interface OrgOption {
  organizationId: string;
  name: string | null;
  role: string;
}

/**
 * Organization switcher (live mode). The selection is validated server-side
 * against the caller's OWN memberships before the org cookie is set — and the
 * backend re-authorizes every call regardless; this only scopes the UI.
 */
export function OrgSwitcher({
  organizations,
  activeOrgId,
}: {
  organizations: OrgOption[];
  activeOrgId: string | null;
}) {
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");

  const onChange = async (organizationId: string) => {
    if (!organizationId || organizationId === activeOrgId || working) return;
    setWorking(true);
    setError("");
    try {
      const res = await fetch("/api/auth/org", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ organizationId }),
      });
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
        setError(json.error?.message ?? "Could not switch organization.");
        setWorking(false);
        return;
      }
      // Server components re-read the org cookie — full reload is authoritative.
      window.location.reload();
    } catch {
      setError("Could not switch organization.");
      setWorking(false);
    }
  };

  if (organizations.length <= 1) return null;

  return (
    <span className="flex items-center gap-2">
      <label htmlFor="org-switch" className="sr-only">Switch organization</label>
      <select
        id="org-switch"
        value={activeOrgId ?? ""}
        disabled={working}
        onChange={(e) => void onChange(e.target.value)}
        className="h-7 rounded-lg border border-line bg-card px-[8px] text-[11.5px] font-medium text-body outline-none focus-visible:outline-2 focus-visible:outline-action disabled:opacity-50"
      >
        {activeOrgId === null && <option value="">Choose…</option>}
        {organizations.map((o) => (
          <option key={o.organizationId} value={o.organizationId}>
            {o.name ?? o.organizationId}
          </option>
        ))}
      </select>
      {error && (
        <span role="alert" className="text-[11px] font-medium text-critical">{error}</span>
      )}
    </span>
  );
}
