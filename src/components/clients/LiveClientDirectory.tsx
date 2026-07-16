import Link from "next/link";
import { Users } from "lucide-react";
import type { PatientDirectoryEntry } from "@/adapters/types";
import { Card } from "@/components/ui/bits";
import { ClinicalEmpty } from "@/components/ui/ClinicalStates";
import { patientPath } from "@/lib/routes";

/**
 * LIVE patient directory — real `patient_profiles` rows under the signed-in
 * practitioner's RLS view. Shows recorded fields only: no synthesized
 * programs, adherence, or visit data (those have no live source yet, and this
 * screen never fabricates them). Server-rendered; errors are handled by the
 * page around it.
 */
export function LiveClientDirectory({ entries }: { entries: PatientDirectoryEntry[] }) {
  if (entries.length === 0) {
    return (
      <section data-screen-label="Clients" className="px-6 pt-[22px] pb-6">
        <ClinicalEmpty
          icon={<Users size={20} strokeWidth={1.75} className="text-slate-badge" aria-hidden />}
          title="No accessible patients"
          message="No patient records are visible to your account in this organization. Seed the demo practice or ask an administrator to assign you to a patient."
        />
      </section>
    );
  }

  const th =
    "whitespace-nowrap px-[12px] py-[8px] text-left text-[10px] font-bold tracking-[0.03em] text-faint uppercase";
  const td = "whitespace-nowrap px-[12px] py-[9px] align-middle text-[12.5px]";

  return (
    <section data-screen-label="Clients" className="px-6 pt-[22px] pb-6">
      <div className="mb-3 flex items-baseline justify-between">
        <h1 className="m-0 text-[17px] font-bold tracking-[-0.01em]">Clients</h1>
        <span className="text-[11.5px] text-subtle">
          {entries.length} patient{entries.length === 1 ? "" : "s"} · live record, scoped to your access
        </span>
      </div>

      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[12.5px]">
            <caption className="sr-only">
              Patients visible to your account, with recorded demographics
            </caption>
            <thead>
              <tr className="bg-[#F6F9FC]">
                <th scope="col" className={th}>Patient</th>
                <th scope="col" className={th}>MRN</th>
                <th scope="col" className={th}>Sex</th>
                <th scope="col" className={th}>Age</th>
                <th scope="col" className={th}>Date of birth</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((p) => (
                <tr key={p.id} className="border-t border-[#F1F5F9] hover:bg-sunken">
                  <td className={td}>
                    <Link
                      href={patientPath(p.id)}
                      className="font-semibold text-ink hover:text-action focus-visible:outline-2 focus-visible:outline-action"
                    >
                      {p.name}
                    </Link>
                  </td>
                  <td className={`${td} text-muted`}>{p.mrn}</td>
                  <td className={`${td} text-body`}>{p.sex}</td>
                  <td className={`${td} text-body`}>{p.age == null ? "—" : p.age}</td>
                  <td className={`${td} text-muted`}>{p.dob}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </section>
  );
}
