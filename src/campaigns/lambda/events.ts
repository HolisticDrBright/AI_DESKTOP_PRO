import { campaignRuntime } from '../runtime';
import { createSesEventHandler } from '../ses-events';
import { buildEngineDeps } from './build';

/** SES events from the marketing configuration sets, by SNS (Lambda protocol). Off: events are acknowledged and dropped. */
type Handle = ReturnType<typeof createSesEventHandler>;
let ready: Promise<Handle> | null = null;
export async function handler(envelope: Parameters<Handle>[0]) {
  const runtime = campaignRuntime(process.env);
  if (!runtime.enabled) return { disabled: true };
  if (!runtime.eventsTopicArn) throw new Error('campaign_configuration_incomplete:CAMPAIGN_EVENTS_TOPIC_ARN');
  ready ??= buildEngineDeps(runtime).then(deps => createSesEventHandler({ ...deps, topicArn: runtime.eventsTopicArn! }));
  return (await ready)(envelope);
}
