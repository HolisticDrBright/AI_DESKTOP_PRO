import { Check, Minus, UsersRound } from "lucide-react";
import { CAPABILITIES, ROLES } from "@/adapters/permissions.mock";
import { Card } from "@/components/ui/bits";

/**
 * Role & permission matrix — documents the INTENDED policy. Enforcement is
 * the database layer (org roles + RLS gates, proven by the live keystone
 * tests); this screen is the human-readable mirror of that policy.
 */
export function PermissionMatrix() {
  return (
    <section data-screen-label="Team & Permissions" className="relative mx-auto max-w-[1080px] px-6 pt-[24px] pb-10">
      <div className="mb-1 text-[11.5px] font-semibold text-faint">Operations / Team</div>
      <div className="mb-4">
        <div className="flex items-center gap-[7px]">
          <UsersRound size={17} strokeWidth={2} className="text-brand" aria-hidden />
          <h1 className="m-0 text-[21px] font-bold tracking-[-0.015em]">Roles &amp; permissions</h1>
        </div>
        <p className="mt-[4px] mb-0 max-w-[680px] text-[12.5px] leading-[1.5] text-subtle">
          The intended capability matrix per role. Enforcement lives in the database layer
          (organization roles + row-level security, including assignment-gated patient access and
          role-gated clinical writes) — this table documents the policy those gates implement.
        </p>
      </div>

      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[12px]">
            <caption className="sr-only">Capabilities per role</caption>
            <thead>
              <tr>
                <th scope="col" className="min-w-[230px] bg-[#F6F9FC] px-[12px] py-[9px] text-left text-[9.5px] font-bold tracking-[0.03em] text-faint uppercase">Capability</th>
                {ROLES.map((r) => (
                  <th key={r.id} scope="col" className="bg-[#F6F9FC] px-[10px] py-[9px] text-center text-[9.5px] font-bold tracking-[0.03em] text-faint uppercase">
                    {r.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {CAPABILITIES.map((row) => (
                <tr key={row.capability} className="border-t border-[#F1F5F9] hover:bg-sunken">
                  <th scope="row" className="px-[12px] py-[8px] text-left font-normal">
                    <span className="block text-[12px] font-semibold text-ink">{row.capability}</span>
                    {row.note && <span className="text-[10px] text-faint">{row.note}</span>}
                  </th>
                  {ROLES.map((r) => {
                    const granted = row.grants[r.id];
                    return (
                      <td key={r.id} className="px-[10px] py-[8px] text-center">
                        {granted ? (
                          <span className="inline-flex items-center gap-[3px] text-positive">
                            <Check size={13} strokeWidth={2.5} aria-hidden />
                            <span className="sr-only">Granted</span>
                          </span>
                        ) : (
                          <span className="inline-flex items-center text-ghost">
                            <Minus size={13} strokeWidth={2} aria-hidden />
                            <span className="sr-only">Not granted</span>
                          </span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="mt-4 grid grid-cols-3 gap-3">
        {ROLES.slice(0, 6).map((r) => (
          <div key={r.id} className="rounded-[10px] border border-line bg-card px-[12px] py-[9px]">
            <span className="block text-[12px] font-bold text-ink">{r.label}</span>
            <span className="text-[11px] text-subtle">{r.note}</span>
          </div>
        ))}
      </div>

      <p className="mt-4 text-[11px] leading-[1.5] text-faint">
        Team member management (invitations, role changes, deactivation) ships with the backend
        membership UI. Roles shown here match the database role enumeration.
      </p>
    </section>
  );
}
