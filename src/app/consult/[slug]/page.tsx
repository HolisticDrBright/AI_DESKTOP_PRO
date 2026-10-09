import type { Metadata } from "next";

import { ConsultRequestForm } from "@/components/consult/ConsultRequestForm";

/**
 * The page a consult link opens.
 *
 * It is public, so it is rendered without the practitioner shell and without a session, and
 * it is told nothing about the clinic beyond what the link itself publishes. The slug is
 * passed straight to the client component, which asks the server to describe it: an invalid
 * or retired slug is answered by the same refusal as one that never existed, so this page
 * cannot be used to discover which clinics are here.
 */
export const metadata: Metadata = {
  title: "Request a consultation",
  description: "Ask a clinic for a first appointment.",
  robots: { index: false, follow: false },
};

export default async function ConsultLinkPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <ConsultRequestForm slug={slug} />;
}
