import type { Metadata } from "next";
import { TemplateLibrary } from "@/components/templates/TemplateLibrary";

export const metadata: Metadata = { title: "Template library — AI Longevity Pro" };

export default async function TemplatesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const type = typeof sp.type === "string" ? sp.type : undefined;
  return <TemplateLibrary initialType={type === "assessment" ? "assessment" : type} />;
}
