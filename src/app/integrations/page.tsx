import type { Metadata } from "next";
import { IntegrationsWorkspace } from "@/components/integrations/IntegrationsWorkspace";

export const metadata: Metadata = { title: "Integrations — AI Longevity Pro" };

export default async function IntegrationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const tab = typeof sp.tab === "string" ? sp.tab : "connections";
  return <IntegrationsWorkspace tab={tab} />;
}
