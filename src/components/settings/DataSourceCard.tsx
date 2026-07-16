import { AlertTriangle, Check, Database, Minus } from "lucide-react";
import Link from "next/link";
import { describeMode } from "@/adapters/mode";
import { cookies } from "next/headers";
import { readAuthSession } from "@/adapters/auth.server";
import { getLiveServerStatus } from "@/adapters/live-status.server";
import { organizationsLive } from "@/adapters/organizations.live";
import { SignOutButton } from "@/components/auth/SignOutButton";
import { OrgSwitcher } from "@/components/settings/OrgSwitcher";
import { Card, CardTitle } from "@/components/ui/bits";

/**
 * Data source & environment status (server component).
 *
 * Shows whether the app is running against the DEMO layer or the LIVE backend,
 * whether the live backend is configured (presence only — never values), and
 * warns clearly when dev-only identity overrides are active. This is the
 * env/status indicator for the vertical slice; details live in docs/live-api.md.
 */
export async function DataSourceCard() {
  const mode = describeMode();
  const server = getLiveServerStatus();
  const session = mode.live ? readAuthSession(await cookies()) : null;

  // Organizations for the signed-in practitioner (tolerated failure: the row
  // shows the honest state; backend reachability has its own rows below).
  let organizations: { organizationId: string; name: string | null; role: string }[] = [];
  if (mode.live && session?.signedIn && session.accessToken) {
    try {
      const orgs = await organizationsLive.mine(session.accessToken);
      organizations = orgs
        .filter((o): o is typeof o & { organizationId: string } => Boolean(o.organizationId))
        .map((o) => ({ organizationId: o.organizationId, name: o.name, role: o.role }));
    } catch {
      organizations = [];
    }
  }
  const activeOrg = organizations.find((o) => o.organizationId === session?.orgId) ?? null;
  const overrideNames = [
    mode.devOverrides.orgId && "org",
    mode.devOverrides.patientId && "patient",
    mode.devOverrides.practitionerId && "practitioner",
  ]
    .filter(Boolean)
    .join(", ");

  const StatusRow = ({
    label,
    ok,
    okText = "Configured",
    offText = "Not set",
  }: {
    label: string;
    ok: boolean;
    okText?: string;
    offText?: string;
  }) => (
    <div className="flex items-center justify-between gap-3 border-t border-hairline-2 py-[8px] first:border-t-0">
      <span className="text-[12px] text-body">{label}</span>
      <span
        className={`flex items-center gap-[5px] text-[12px] font-semibold ${ok ? "text-positive" : "text-faint"}`}
      >
        {ok ? <Check size={13} strokeWidth={2.5} aria-hidden /> : <Minus size={13} strokeWidth={2.5} aria-hidden />}
        {ok ? okText : offText}
      </span>
    </div>
  );

  return (
    <div className="mx-auto max-w-[420px] px-6 pb-6">
      <Card className="px-4 py-[14px]">
        <CardTitle className="mb-[4px]">
          <Database size={13} strokeWidth={2} className="text-brand" aria-hidden />
          Data source &amp; environment
        </CardTitle>

        <div className="mt-[6px] mb-[10px] flex items-center gap-2">
          <span
            className={`rounded-full px-[10px] py-[3px] text-[11px] font-bold ${
              mode.live ? "bg-positive-tint text-positive" : "bg-slate-tint text-slate-badge"
            }`}
          >
            {mode.live ? "LIVE backend" : "DEMO (mock)"}
          </span>
          <span className="text-[11px] text-subtle">
            {mode.live
              ? "Flag-enabled namespaces read/write the real clinical backend under RLS."
              : "All data is in-session demo data; nothing is persisted to a backend."}
          </span>
        </div>

        <StatusRow label="NEXT_PUBLIC_USE_LIVE_API" ok={mode.live} okText="On" offText="Off (default)" />

        {mode.live && (
          <>
            {/* Auth: signed in / signed out / expired — distinct from backend reachability. */}
            <div className="flex items-center justify-between gap-3 border-t border-hairline-2 py-[8px]">
              <span className="text-[12px] text-body">Practitioner session</span>
              {session?.signedIn ? (
                <span className="flex items-center gap-2">
                  <span className="flex items-center gap-[5px] text-[12px] font-semibold text-positive">
                    <Check size={13} strokeWidth={2.5} aria-hidden />
                    {session.email ?? "Signed in"}
                  </span>
                  <SignOutButton />
                </span>
              ) : (
                <Link
                  href="/login"
                  className="text-[12px] font-semibold text-action hover:text-action-deep focus-visible:outline-2 focus-visible:outline-action"
                >
                  {session?.expired ? "Session expired — sign in →" : "Signed out — sign in →"}
                </Link>
              )}
            </div>
            {/* Organization: session-scoped (validated cookie), never env in prod. */}
            <div className="flex items-center justify-between gap-3 border-t border-hairline-2 py-[8px]">
              <span className="text-[12px] text-body">Organization</span>
              {session?.signedIn ? (
                <span className="flex items-center gap-2">
                  <span
                    className={`text-[12px] font-semibold ${activeOrg ? "text-positive" : "text-warning-deep"}`}
                  >
                    {activeOrg
                      ? `${activeOrg.name ?? activeOrg.organizationId} · ${activeOrg.role}`
                      : organizations.length > 0
                        ? "None selected"
                        : "No memberships found"}
                  </span>
                  <OrgSwitcher organizations={organizations} activeOrgId={session.orgId} />
                </span>
              ) : (
                <span className="text-[12px] font-semibold text-faint">Sign in first</span>
              )}
            </div>
            <StatusRow label="tRPC backend endpoint" ok={server.trpcConfigured} />
            <StatusRow
              label="Env fallback session (local/e2e only)"
              ok={server.demoSessionConfigured}
              okText="Present"
              offText="Not set (expected in production)"
            />
            <StatusRow label="Organization scope" ok={server.orgConfigured} />
          </>
        )}

        {mode.anyDevOverride && (
          <div className="mt-[10px] flex items-start gap-[7px] rounded-[9px] border border-[rgba(199,126,20,0.28)] bg-warning-tint px-[11px] py-[9px]">
            <AlertTriangle size={14} strokeWidth={2} className="mt-px shrink-0 text-warning-deep" aria-hidden />
            <span className="text-[11px] leading-[1.45] text-warning-deep">
              Dev identity overrides active{overrideNames && <> ({overrideNames})</>}.{" "}
              <strong className="font-semibold">Local development only — unsafe for production.</strong> These
              are not authentication; the backend still enforces RLS against the real session.
            </span>
          </div>
        )}

        <p className="mt-[10px] mb-0 text-[10.5px] leading-[1.5] text-faint">
          Backend access stays behind the adapter façade and the authenticated tRPC layer (ADR
          0002). See{" "}
          <Link
            href="https://github.com/HolisticDrBright/AI_DESKTOP_PRO/blob/main/docs/live-api.md"
            className="font-semibold text-action hover:text-action-deep"
          >
            docs/live-api.md
          </Link>{" "}
          to run the live path.
        </p>
      </Card>
    </div>
  );
}
