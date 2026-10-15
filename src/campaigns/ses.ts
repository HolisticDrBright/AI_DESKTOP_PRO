import { CreateEmailIdentityCommand, CreateTenantCommand, CreateTenantResourceAssociationCommand, GetAccountCommand, GetEmailIdentityCommand,
  PutEmailIdentityMailFromAttributesCommand, SendEmailCommand, type SESv2Client } from '@aws-sdk/client-sesv2';
import type { DomainStatus } from './contract';

/**
 * Amazon SES v2 behind a narrow port: marketing sending only. The port is given the marketing configuration set
 * by the engine on every send, and the AWS implementation refuses any configuration set that is not a marketing
 * one, so `alp-transactional` (appointment and account email) can never carry a campaign.
 *
 * **One SES tenant per practice.** SES tenants (`CreateTenant`, `CreateTenantResourceAssociation`, `TenantName` on
 * `SendEmail`) keep each practice's sending reputation separate: a high bounce or complaint rate pauses that
 * tenant, not every practice. A send names the practice's tenant and succeeds only when every resource it uses
 * (the domain identity and the configuration set) is associated with that tenant.
 */
export type SendReply =
  | { outcome: 'accepted'; messageId: string }
  /** Definitely not accepted (an SES error answer): safe to try again later. */
  | { outcome: 'refused'; detail: 'request_invalid' | 'paused' | 'provider_unavailable' }
  /** No answer (timeout, connection lost): it may have been sent, so it is never retried. */
  | { outcome: 'unknown' };
export type OutgoingEmail = {
  from: string; to: string; subject: string; html: string; text: string;
  headers: { name: string; value: string }[]; configurationSet: string; tenant: string;
  tags: { name: string; value: string }[];
};
export interface CampaignSesPort {
  send(email: OutgoingEmail): Promise<SendReply>;
  /** Creates the practice's tenant and domain identity (tagged as marketing), sets the custom MAIL FROM, associates both. */
  registerDomain(input: { domain: string; tenant: string; configurationSets: readonly string[] }): Promise<DomainStatus>;
  domainStatus(domain: string): Promise<DomainStatus>;
  /** The account's sending rate, per second, from GetAccount. */
  maxSendRate(): Promise<number>;
}

export const MARKETING_IDENTITY_TAG = Object.freeze({ Key: 'alp-purpose', Value: 'marketing' });
const MARKETING_SET = /^alp-marketing(?:-[a-z0-9-]{1,40})?$/;

export function tenantNameFor(practiceId: string): string {
  return `alp-practice-${practiceId.replace(/-/g, '').toLowerCase()}`;
}

/** The DNS records a practice adds: DKIM, the custom MAIL FROM (MX and SPF) and a starting DMARC policy. */
export function dnsRecordsFor(domain: string, region: string, dkimTokens: readonly string[]): DomainStatus['records'] {
  return [
    ...dkimTokens.slice(0, 3).map(token => ({ type: 'CNAME' as const, name: `${token}._domainkey.${domain}`, value: `${token}.dkim.amazonses.com`, purpose: 'dkim' as const })),
    { type: 'MX', name: `bounce.${domain}`, value: `10 feedback-smtp.${region}.amazonses.com`, purpose: 'mail_from' },
    { type: 'TXT', name: `bounce.${domain}`, value: '"v=spf1 include:amazonses.com ~all"', purpose: 'spf' },
    { type: 'TXT', name: `_dmarc.${domain}`, value: '"v=DMARC1; p=none;"', purpose: 'dmarc' },
  ];
}

const status = (value: string | undefined): DomainStatus['dkim'] => {
  const v = String(value ?? 'NOT_STARTED').toLowerCase();
  return (['pending', 'success', 'failed', 'temporary_failure', 'not_started'] as const).find(s => s === v) ?? 'not_started';
};

export function createAwsCampaignSes(input: { client: Pick<SESv2Client, 'send'>; region: string; accountId: string; now?: () => Date }): CampaignSesPort {
  const { client, region, accountId } = input;
  if (!/^[a-z]{2}-[a-z]+-\d$/.test(region) || !/^\d{12}$/.test(accountId)) throw new Error('campaign_ses_configuration_invalid');
  const now = input.now ?? (() => new Date());
  async function domainStatus(domain: string): Promise<DomainStatus> {
    const identity = await client.send(new GetEmailIdentityCommand({ EmailIdentity: domain }));
    return {
      domain, verifiedForSending: identity.VerifiedForSendingStatus === true,
      dkim: status(identity.DkimAttributes?.Status), mailFrom: status(identity.MailFromAttributes?.MailFromDomainStatus),
      records: dnsRecordsFor(domain, region, identity.DkimAttributes?.Tokens ?? []), checkedAt: now().toISOString(),
    };
  }
  return {
    async send(email) {
      if (!MARKETING_SET.test(email.configurationSet)) return { outcome: 'refused', detail: 'request_invalid' };
      try {
        const result = await client.send(new SendEmailCommand({
          FromEmailAddress: email.from, Destination: { ToAddresses: [email.to] }, ConfigurationSetName: email.configurationSet, TenantName: email.tenant,
          EmailTags: email.tags.map(tag => ({ Name: tag.name, Value: tag.value })),
          Content: { Simple: { Subject: { Data: email.subject, Charset: 'UTF-8' }, Body: { Html: { Data: email.html, Charset: 'UTF-8' }, Text: { Data: email.text, Charset: 'UTF-8' } },
            Headers: email.headers.map(h => ({ Name: h.name, Value: h.value })) } },
        }));
        return result.MessageId ? { outcome: 'accepted', messageId: result.MessageId } : { outcome: 'unknown' };
      } catch (error) {
        const e = error as { name?: string; $metadata?: { httpStatusCode?: number } };
        if (!e.$metadata?.httpStatusCode) return { outcome: 'unknown' };
        if (e.name === 'AccountSuspendedException' || e.name === 'SendingPausedException') return { outcome: 'refused', detail: 'paused' };
        if (e.name === 'MessageRejected' || e.name === 'BadRequestException' || e.name === 'MailFromDomainNotVerifiedException' || e.name === 'NotFoundException') return { outcome: 'refused', detail: 'request_invalid' };
        return { outcome: 'refused', detail: 'provider_unavailable' };
      }
    },
    async registerDomain({ domain, tenant, configurationSets }) {
      if (configurationSets.some(set => !MARKETING_SET.test(set))) throw new Error('campaign_configuration_set_refused');
      await client.send(new CreateTenantCommand({ TenantName: tenant, Tags: [MARKETING_IDENTITY_TAG] })).catch(ignoreExists);
      await client.send(new CreateEmailIdentityCommand({ EmailIdentity: domain, Tags: [MARKETING_IDENTITY_TAG] })).catch(ignoreExists);
      await client.send(new PutEmailIdentityMailFromAttributesCommand({ EmailIdentity: domain, MailFromDomain: `bounce.${domain}`, BehaviorOnMxFailure: 'USE_DEFAULT_VALUE' }));
      for (const arn of [`arn:aws:ses:${region}:${accountId}:identity/${domain}`, ...configurationSets.map(set => `arn:aws:ses:${region}:${accountId}:configuration-set/${set}`)]) {
        await client.send(new CreateTenantResourceAssociationCommand({ TenantName: tenant, ResourceArn: arn })).catch(ignoreExists);
      }
      return domainStatus(domain);
    },
    domainStatus,
    async maxSendRate() {
      const account = await client.send(new GetAccountCommand({}));
      const rate = Number(account.SendQuota?.MaxSendRate ?? 1);
      return Number.isFinite(rate) && rate > 0 ? rate : 1;
    },
  };
}
function ignoreExists(error: unknown): void {
  if ((error as { name?: string }).name !== 'AlreadyExistsException') throw error;
}

/* ------------------------------------------------------------------------------------------ a fictional SES for tests */

export function createFakeCampaignSes(options: { region?: string } = {}) {
  const outbox: OutgoingEmail[] = [];
  const domains = new Map<string, { verified: boolean; tenant: string; sets: string[] }>();
  const queue: SendReply[] = [];
  let n = 0;
  const port: CampaignSesPort = {
    async send(email) {
      if (!MARKETING_SET.test(email.configurationSet)) return { outcome: 'refused', detail: 'request_invalid' };
      const scripted = queue.shift();
      if (scripted && scripted.outcome !== 'accepted') return scripted;
      outbox.push(structuredClone(email));
      return { outcome: 'accepted', messageId: `fictional-message-${++n}` };
    },
    async registerDomain({ domain, tenant, configurationSets }) {
      domains.set(domain, { verified: false, tenant, sets: [...configurationSets] });
      return port.domainStatus(domain);
    },
    async domainStatus(domain) {
      const d = domains.get(domain);
      return { domain, verifiedForSending: d?.verified ?? false, dkim: d?.verified ? 'success' : 'pending', mailFrom: d?.verified ? 'success' : 'pending',
        records: dnsRecordsFor(domain, options.region ?? 'us-east-2', ['fictionaldkimtokena', 'fictionaldkimtokenb', 'fictionaldkimtokenc']), checkedAt: new Date(0).toISOString() };
    },
    async maxSendRate() { return 14; },
  };
  return { port, outbox, domains, verify(domain: string) { const d = domains.get(domain); if (d) d.verified = true; }, next(reply: SendReply) { queue.push(reply); } };
}
