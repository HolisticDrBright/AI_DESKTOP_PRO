import { telehealthConsentConfigurationIdentity } from './telehealth-consent-deployment';

/** Credential-free stdin tool. Prints only the configuration digest, never
 * input, identifiers, consent copy or an approval claim. No AWS calls. */
async function main() {
  if (process.argv.length !== 2) throw Error('input_refused');
  const chunks: Buffer[] = []; let size = 0;
  const deadline = setTimeout(() => process.stdin.destroy(Error('input_refused')), 10000);
  deadline.unref();
  try {
    for await (const chunk of process.stdin) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > 20000) { process.stdin.destroy(); throw Error('input_refused'); }
      chunks.push(bytes);
    }
  } finally { clearTimeout(deadline); }
  const input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  process.stdout.write(JSON.stringify(telehealthConsentConfigurationIdentity(input)) + '\n');
}
void main().catch(() => { process.stderr.write('telehealth_consent_configuration_input_refused\n'); process.exitCode = 1; });
