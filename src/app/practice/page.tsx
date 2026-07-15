import type { Metadata } from "next";
import { api } from "@/adapters";
import { PracticeDashboard } from "@/components/practice/PracticeDashboard";

export const metadata: Metadata = { title: "Practice dashboard — AI Longevity Pro" };

export default async function PracticePage() {
  const data = await api.practice.dashboard();
  return <PracticeDashboard data={data} />;
}
