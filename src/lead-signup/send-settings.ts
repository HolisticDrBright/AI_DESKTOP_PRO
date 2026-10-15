import { CAMPAIGN_SEND_SETTINGS, CAMPAIGN_TEXT_VERSION, type CampaignSendSetting } from '@/contracts/leadCampaigns';

/**
 * The campaign service's sending settings: Brandon's decisions, read from the service's own environment and
 * never given a default. While any is unset or malformed, or the approved text version is not the current
 * one, `ready` is false and the service sends nothing at all (not even a confirmation email). The names of
 * the missing settings, and only their names, are reported to the Desktop's Campaigns and Outreach status
 * screens.
 *
 * - `CAMPAIGN_SENDING_SUBDOMAIN`: the dedicated subdomain verified in SES for marketing mail only. Mail is
 *   sent from `updates@<subdomain>`.
 * - `CAMPAIGN_FROM_NAME`: the name shown as the sender.
 * - `CAMPAIGN_MAILING_ADDRESS`: the physical mailing address printed in every email.
 * - `CAMPAIGN_TRACKING`: `on` or `off`, chosen explicitly. It must match the SES configuration set's open
 *   and click events, which the infrastructure template takes as a parameter with no default.
 * - `CAMPAIGN_APPROVED_TEXT_VERSION`: the text version Brandon approved; it must equal `CAMPAIGN_TEXT_VERSION`.
 */
export type CampaignSendValues = { subdomain: string; fromName: string; fromAddress: string; mailingAddress: string; tracking: 'on' | 'off' };
export type CampaignSendReadiness =
  | { ready: true; missing: []; values: CampaignSendValues }
  | { ready: false; missing: CampaignSendSetting[] };

const SUBDOMAIN = /^(?=.{4,190}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.){2,}[a-z]{2,63}$/;
const FROM_NAME = /^[\p{L}\p{N}][\p{L}\p{N} &.,'-]{0,59}$/u;
const ADDRESS = /^[\p{L}\p{N}][\p{L}\p{N} #&.,'/-]{9,199}$/u;

export function campaignSendReadiness(env: Record<string, string | undefined>): CampaignSendReadiness {
  const value = (name: CampaignSendSetting) => (env[name] ?? '').trim();
  const subdomain = value('CAMPAIGN_SENDING_SUBDOMAIN').toLowerCase();
  const fromName = value('CAMPAIGN_FROM_NAME');
  const mailingAddress = value('CAMPAIGN_MAILING_ADDRESS');
  const tracking = value('CAMPAIGN_TRACKING');
  const valid: Record<CampaignSendSetting, boolean> = {
    CAMPAIGN_SENDING_SUBDOMAIN: SUBDOMAIN.test(subdomain),
    CAMPAIGN_FROM_NAME: FROM_NAME.test(fromName),
    CAMPAIGN_MAILING_ADDRESS: ADDRESS.test(mailingAddress),
    CAMPAIGN_TRACKING: tracking === 'on' || tracking === 'off',
    CAMPAIGN_APPROVED_TEXT_VERSION: value('CAMPAIGN_APPROVED_TEXT_VERSION') === CAMPAIGN_TEXT_VERSION,
  };
  const missing = CAMPAIGN_SEND_SETTINGS.filter(name => !valid[name]);
  if (missing.length > 0) return { ready: false, missing };
  return { ready: true, missing: [], values: { subdomain, fromName, fromAddress: `updates@${subdomain}`, mailingAddress, tracking: tracking as 'on' | 'off' } };
}
