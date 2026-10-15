import { createServer, type IncomingMessage } from 'node:http';
import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2';
import { LEAD_PROGRAMS, type LeadProgram } from '@/contracts/leadCampaigns';
import { createDittofeedDirectory, type DittofeedConfig } from './dittofeed';
import { campaignSendReadiness, type CampaignSendValues } from './send-settings';
import { createLeadSignupService, type ConfirmationMailer, type LeadSignupConfig, type ServiceRequest } from './service';

/**
 * The sign-up service's process: configuration from its own environment (never the Desktop's), an
 * SES mailer on the MARKETING identity and configuration set, and a node:http listener.
 *
 * Two kinds of configuration, deliberately treated differently:
 * - the wiring (keys, Dittofeed, the stats token, the SES region and marketing configuration set). Without
 *   all of it the service refuses to start;
 * - Brandon's sending decisions (send-settings.ts). Without them it starts, so the Desktop can say what is
 *   missing, and sends nothing.
 *
 * Nothing in the Desktop imports this file.
 */
export type LeadSignupEnvironment = Record<string, string | undefined>;
const https = (value: string | undefined) => { try { const u = new URL(value ?? ''); return u.protocol === 'https:' && u.pathname === '/' && !u.search && !u.hash && !u.username ? u.origin : null; } catch { return null; } };
const key = (value: string | undefined) => { const k = Buffer.from(value ?? '', 'base64'); return k.length >= 32 ? k : null; };

export function leadSignupEnvironment(env: LeadSignupEnvironment) {
  const publicOrigin = https(env.LEAD_SIGNUP_PUBLIC_ORIGIN), linkKey = key(env.LEAD_SIGNUP_LINK_KEY), idKey = key(env.LEAD_SIGNUP_ID_KEY);
  const groups = Object.fromEntries(LEAD_PROGRAMS.map(p => [p, env[`DITTOFEED_GROUP_${p.replaceAll('-', '_').toUpperCase()}`] ?? ''])) as Record<LeadProgram, string>;
  const dittofeed: DittofeedConfig = { baseUrl: env.DITTOFEED_INTERNAL_URL ?? '', workspaceId: env.DITTOFEED_WORKSPACE_ID ?? '', writeKey: env.DITTOFEED_WRITE_KEY ?? '', adminKey: env.DITTOFEED_ADMIN_KEY ?? '', groups };
  const ses = { region: env.LEAD_SES_REGION ?? '', configurationSet: env.LEAD_SES_CONFIGURATION_SET ?? '' };
  const ok = publicOrigin && linkKey && idKey && !linkKey.equals(idKey)
    && /^https?:\/\/[a-z0-9.-]+(:[0-9]{2,5})?$/.test(dittofeed.baseUrl) && /^[0-9a-f-]{36}$/.test(dittofeed.workspaceId) && dittofeed.writeKey.length >= 16 && dittofeed.adminKey.length >= 16
    && Object.values(groups).every(g => /^[0-9a-f-]{36}$/.test(g)) && new Set(Object.values(groups)).size === LEAD_PROGRAMS.length
    && (env.LEAD_SIGNUP_STATS_TOKEN ?? '').length >= 32 && /^[a-z]{2}-[a-z]+-[0-9]$/.test(ses.region)
    // Never the clinical transactional set: marketing complaints must not touch appointment and account email.
    && /^[A-Za-z0-9_-]{1,64}$/.test(ses.configurationSet) && ses.configurationSet !== 'alp-transactional';
  if (!ok) return null;
  const config: LeadSignupConfig = { publicOrigin, linkKey, idKey, statsToken: env.LEAD_SIGNUP_STATS_TOKEN! };
  return { config, dittofeed, ses, sending: campaignSendReadiness(env) };
}

/** The mailer exists only with complete sending settings; its From is the marketing subdomain and the decided name. */
export function createSesConfirmationMailer(ses: { region: string; configurationSet: string }, values: CampaignSendValues, client: Pick<SESv2Client, 'send'> = new SESv2Client({ region: ses.region })): ConfirmationMailer {
  const from = `"${values.fromName}" <${values.fromAddress}>`;
  return { async send({ to, subject, text }) {
    try {
      const reply = await client.send(new SendEmailCommand({ FromEmailAddress: from, ConfigurationSetName: ses.configurationSet,
        Destination: { ToAddresses: [to] }, Content: { Simple: { Subject: { Data: subject }, Body: { Text: { Data: text } } } } }));
      return Boolean(reply.MessageId);
    } catch { return false; }
  } };
}

async function readForm(request: IncomingMessage, limit = 4096): Promise<URLSearchParams | null> {
  if (!/^application\/x-www-form-urlencoded\b/.test(request.headers['content-type'] ?? '')) return null;
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) { size += (chunk as Buffer).length; if (size > limit) return null; chunks.push(chunk as Buffer); }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

export function startLeadSignupServer(env: LeadSignupEnvironment = process.env, port = Number(env.PORT ?? 8080)) {
  const parsed = leadSignupEnvironment(env);
  if (!parsed) throw new Error('lead_signup_configuration_invalid');
  const { sending } = parsed;
  // With incomplete sending settings there is no mailer at all: the service cannot send even by mistake.
  const mailer: ConfirmationMailer = sending.ready ? createSesConfirmationMailer(parsed.ses, sending.values) : { async send() { return false; } };
  const handle = createLeadSignupService({ config: parsed.config, sending, directory: createDittofeedDirectory(parsed.dittofeed), mailer });
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const request: ServiceRequest = { method: req.method ?? 'GET', path: url.pathname, query: url.searchParams,
        form: req.method === 'POST' ? await readForm(req) : null, authorization: req.headers.authorization ?? null };
      const response = await handle(request);
      res.writeHead(response.status, response.headers).end(response.body);
    } catch { res.writeHead(500, { 'content-type': 'text/plain' }).end('Unavailable'); }
  });
  return server.listen(port);
}
