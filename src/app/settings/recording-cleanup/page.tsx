import type {Metadata} from 'next';
import {RecordingCleanupReviewWorkspace} from '@/components/settings/RecordingCleanupReviewWorkspace';
import {recordingCleanupExecutionConfigured} from '@/adapters/recording-cleanup-execution.server';
export const dynamic='force-dynamic';
export const metadata:Metadata={title:'Recording cleanup review — AI Longevity Pro'};
export default function RecordingCleanupPage(){return <section data-screen-label="Recording cleanup review" className="mx-auto max-w-[1100px] px-6 py-6">
  <h1 className="text-xl font-bold mb-3">Recording cleanup review</h1><RecordingCleanupReviewWorkspace executionConfigured={recordingCleanupExecutionConfigured()}/>
</section>;}
