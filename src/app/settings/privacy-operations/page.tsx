import type {Metadata} from 'next';
import {PrivacyOperationsWorkspace} from '@/components/settings/PrivacyOperationsWorkspace';
export const metadata:Metadata={title:'Privacy operations — AI Longevity Pro'};
export default function PrivacyOperationsPage(){
  return <section data-screen-label="Privacy operations" className="mx-auto max-w-[1100px] px-6 py-6">
    <h1 className="text-xl font-bold mb-3">Privacy operations</h1>
    <PrivacyOperationsWorkspace/>
  </section>;
}
