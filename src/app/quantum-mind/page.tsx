import { redirect } from "next/navigation";

/** Quantum Mind is now Mind & Cognition inside Tracking & Experiments. */
export default function QuantumMindRedirect() {
  redirect("/patients");
}
