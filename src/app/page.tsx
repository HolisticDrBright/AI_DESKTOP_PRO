import { redirect } from "next/navigation";

/**
 * Entry point. The practitioner's day starts on the Today brief in BOTH
 * modes — mock renders the synthetic practice, live renders the real
 * schedule/queue with demo-only sections reduced to honest states.
 */
export default function Home() {
  redirect("/today");
}
