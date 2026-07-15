import { redirect } from "next/navigation";
import { DEFAULT_PATIENT_ID } from "@/adapters";
import { patientPath } from "@/lib/routes";

export default function Home() {
  redirect(patientPath(DEFAULT_PATIENT_ID));
}
