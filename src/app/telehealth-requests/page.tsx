import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/PageHeader";
import { TelehealthRequestQueue } from "@/components/schedule/TelehealthRequestQueue";
export const metadata:Metadata={title:"Telehealth requests — AI Longevity Pro"};export const dynamic="force-dynamic";
export default function TelehealthRequestsPage(){return <section className="mx-auto max-w-[1000px] px-[22px] pt-[18px] pb-8"><PageHeader crumb="Workspace / Inbox / Telehealth" title="Telehealth requests" sub="Consumer requests waiting for scheduling. Meeting links remain pending until an approved video provider is active."/><TelehealthRequestQueue/></section>}
