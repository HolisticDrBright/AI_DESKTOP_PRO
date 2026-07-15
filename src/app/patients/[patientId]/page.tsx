import { redirect } from "next/navigation";
import { patientPath } from "@/lib/routes";

export default async function PatientIndexPage({
  params,
}: {
  params: Promise<{ patientId: string }>;
}) {
  const { patientId } = await params;
  redirect(patientPath(patientId));
}
