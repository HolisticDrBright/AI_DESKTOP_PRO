"use client";

import { useCallback, useEffect, useState } from "react";
import { UserPlus, Users } from "lucide-react";
import { Card, CardTitle } from "@/components/ui/bits";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

/**
 * Organization members (live mode, admin surface). Lists the roster, invites
 * by email, changes roles, and removes members. Every rule — admin gating,
 * owner transitions, last-owner lockout, self-removal — is enforced by the
 * backend RPCs; this card renders their honest answers. Non-admins see a
 * plain explanation instead of controls that would always fail.
 */

interface MemberRow {
  membershipId: string;
  userId: string;
  email: string | null;
  displayName: string | null;
  role: string;
  status: string;
  joinedAt: string;
}

const ROLES = ["owner", "admin", "practitioner", "staff", "member"] as const;

const STATUS_LABEL: Record<string, string> = {
  active: "Active",
  invited: "Invited — hasn't signed in yet",
  suspended: "Suspended",
};

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; members: MemberRow[]; selfEmail: string | null }
  | { kind: "blocked"; message: string };

async function readError(res: Response): Promise<string> {
  const json = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
  return json.error?.message ?? "Something went wrong. Please try again.";
}

export function OrgMembersCard() {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<(typeof ROLES)[number]>("practitioner");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<MemberRow | null>(null);

  const load = useCallback(async () => {
    try {
      const sessionRes = await fetch("/api/auth/session");
      const session = (await sessionRes.json().catch(() => ({}))) as {
        data?: { signedIn?: boolean; email?: string | null };
      };
      if (!session.data?.signedIn) {
        setState({ kind: "blocked", message: "Sign in to manage members." });
        return;
      }
      const res = await fetch("/api/live/org/members");
      if (res.status === 403) {
        setState({
          kind: "blocked",
          message: "Member management requires an organization admin or owner.",
        });
        return;
      }
      if (!res.ok) {
        setState({ kind: "blocked", message: await readError(res) });
        return;
      }
      const json = (await res.json()) as { data: MemberRow[] };
      setState({ kind: "ready", members: json.data, selfEmail: session.data.email ?? null });
    } catch {
      setState({
        kind: "blocked",
        message: "The membership service is unreachable right now.",
      });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const invite = async (e: React.FormEvent) => {
    e.preventDefault();
    if (working) return;
    setError(null);
    setNotice(null);
    setWorking(true);
    try {
      const res = await fetch("/api/live/org/members", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: inviteEmail.trim(), role: inviteRole }),
      });
      if (!res.ok) {
        setError(await readError(res));
        return;
      }
      const json = (await res.json()) as { data: { invitedNewUser: boolean } };
      setNotice(
        json.data.invitedNewUser
          ? `Invitation email sent to ${inviteEmail.trim()}.`
          : `${inviteEmail.trim()} has an account already — the practice appears on their next sign-in.`,
      );
      setInviteEmail("");
      await load();
    } catch {
      setError("The membership service is unreachable right now.");
    } finally {
      setWorking(false);
    }
  };

  const changeRole = async (member: MemberRow, role: string) => {
    if (working || role === member.role) return;
    setError(null);
    setNotice(null);
    setWorking(true);
    try {
      const res = await fetch("/api/live/org/member", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ membershipId: member.membershipId, role }),
      });
      if (!res.ok) {
        setError(await readError(res));
        return;
      }
      setNotice(`Role updated to ${role} for ${member.email ?? "member"}.`);
      await load();
    } catch {
      setError("The membership service is unreachable right now.");
    } finally {
      setWorking(false);
    }
  };

  const remove = async (member: MemberRow) => {
    setRemoveTarget(null);
    setError(null);
    setNotice(null);
    setWorking(true);
    try {
      const res = await fetch("/api/live/org/member", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ membershipId: member.membershipId }),
      });
      if (!res.ok) {
        setError(await readError(res));
        return;
      }
      setNotice(`${member.email ?? "Member"} removed from the organization.`);
      await load();
    } catch {
      setError("The membership service is unreachable right now.");
    } finally {
      setWorking(false);
    }
  };

  const selectCls =
    "h-7 rounded-md border border-line bg-card px-1 text-[11.5px] text-body outline-none focus-visible:outline-2 focus-visible:outline-action disabled:opacity-50";

  return (
    <div className="mx-auto max-w-[420px] px-6 pb-6" data-testid="org-members-card">
      <Card className="px-4 py-[16px]">
        <CardTitle className="mb-[4px]">
          <Users size={13} strokeWidth={2.2} className="text-brand" aria-hidden />
          Organization members
        </CardTitle>

        {state.kind === "loading" && (
          <p className="m-0 mt-2 text-[12px] text-subtle">Loading members…</p>
        )}

        {state.kind === "blocked" && (
          <p className="m-0 mt-2 text-[12px] leading-[1.5] text-subtle">{state.message}</p>
        )}

        {state.kind === "ready" && (
          <>
            <ul className="m-0 mt-2 flex list-none flex-col gap-[10px] p-0">
              {state.members.map((m) => {
                const isSelf = Boolean(state.selfEmail && m.email === state.selfEmail);
                return (
                  <li
                    key={m.membershipId}
                    className="flex items-center justify-between gap-2 border-b border-hairline pb-[10px] last:border-b-0 last:pb-0"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-[12.5px] font-semibold text-body">
                        {m.email ?? m.userId}
                        {isSelf && <span className="ml-1 font-normal text-faint">(you)</span>}
                      </div>
                      <div className="text-[11px] text-subtle">
                        {m.displayName ? `${m.displayName} · ` : ""}
                        {STATUS_LABEL[m.status] ?? m.status}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-[6px]">
                      <label className="sr-only" htmlFor={`role-${m.membershipId}`}>
                        Role for {m.email ?? "member"}
                      </label>
                      <select
                        id={`role-${m.membershipId}`}
                        value={m.role}
                        disabled={working}
                        onChange={(e) => void changeRole(m, e.target.value)}
                        className={selectCls}
                      >
                        {ROLES.map((r) => (
                          <option key={r} value={r}>
                            {r}
                          </option>
                        ))}
                      </select>
                      {!isSelf && (
                        <button
                          type="button"
                          disabled={working}
                          onClick={() => setRemoveTarget(m)}
                          className="h-7 cursor-pointer rounded-md border border-line bg-card px-2 text-[11.5px] font-semibold text-critical hover:border-critical focus-visible:outline-2 focus-visible:outline-action disabled:opacity-50"
                        >
                          Remove
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
              {state.members.length === 0 && (
                <li className="text-[12px] text-subtle">No members found.</li>
              )}
            </ul>

            <form onSubmit={invite} className="mt-3 border-t border-hairline pt-3">
              <label
                htmlFor="invite-email"
                className="mb-[5px] block text-[10px] font-bold tracking-[0.04em] text-faint uppercase"
              >
                Invite by email
              </label>
              <div className="flex items-center gap-[6px]">
                <input
                  id="invite-email"
                  type="email"
                  required
                  placeholder="colleague@practice.com"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  className="h-8 min-w-0 flex-1 rounded-md border border-line bg-card px-2 text-[12px] text-body outline-none focus-visible:outline-2 focus-visible:outline-action"
                />
                <label className="sr-only" htmlFor="invite-role">
                  Role for the invitee
                </label>
                <select
                  id="invite-role"
                  value={inviteRole}
                  onChange={(e) => setInviteRole(e.target.value as (typeof ROLES)[number])}
                  className={selectCls}
                >
                  {ROLES.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
                <button
                  type="submit"
                  disabled={working}
                  className="flex h-8 cursor-pointer items-center gap-[5px] rounded-md border-none bg-action px-3 text-[11.5px] font-semibold text-white hover:bg-action-deep focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <UserPlus size={12} strokeWidth={2.2} aria-hidden />
                  {working ? "Working…" : "Invite"}
                </button>
              </div>
              <p className="m-0 mt-[6px] text-[10.5px] leading-[1.5] text-faint">
                Existing accounts are linked immediately; new emails receive an invitation to set
                a password. Membership changes are recorded in the audit log.
              </p>
            </form>

            {notice && (
              <p role="status" className="m-0 mt-2 rounded-md bg-positive-tint px-2 py-[6px] text-[11.5px] font-medium text-ink">
                {notice}
              </p>
            )}
          </>
        )}

        {error && (
          <p role="alert" className="m-0 mt-2 rounded-md bg-critical-tint px-2 py-[6px] text-[11.5px] font-semibold text-critical">
            {error}
          </p>
        )}
      </Card>

      <ConfirmDialog
        open={removeTarget !== null}
        title="Remove member?"
        body={
          removeTarget
            ? `${removeTarget.email ?? "This member"} will lose access to this organization. Their past audit history is preserved.`
            : ""
        }
        confirmLabel="Remove member"
        destructive
        onConfirm={() => removeTarget && void remove(removeTarget)}
        onCancel={() => setRemoveTarget(null)}
      />
    </div>
  );
}
