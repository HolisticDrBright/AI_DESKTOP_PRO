/**
 * A separate OS process for the SQL acceptance test's restart case: it opens the acceptance host on
 * the same on-disk database the parent closed, does one learner operation through the real progress
 * service, prints the answer as one JSON line, closes the database and exits. Nothing is shared with
 * the parent but the directory and the sealing key it is given. Test support only; run by the test.
 *
 *   node node_modules/jiti/lib/jiti-cli.mjs src/test-support/sql-acceptance-child.ts <dataDir> <json command>
 */
import { createFictionalCheckoutProcessor } from "../server/commerce/program-checkout-processor";
import { createFictionalContactAuthority, createFictionalDeliveryProvider } from "../server/commerce/program-claim-delivery";
import { createFictionalIdentityIssuer, openSqlAcceptanceHost } from "../server/commerce/sql-acceptance-host";

async function main() {
  const [dataDir, raw] = process.argv.slice(2);
  if (!dataDir || !raw) throw new Error("usage: <dataDir> <json command>");
  const command = JSON.parse(raw) as { learner: "a" | "b"; body: unknown };
  const host = await openSqlAcceptanceHost(dataDir, {
    processor: createFictionalCheckoutProcessor(), contacts: createFictionalContactAuthority(), provider: createFictionalDeliveryProvider(),
    identity: createFictionalIdentityIssuer(),
    sealerKey: { key: Buffer.from(process.env.ACCEPTANCE_SEALER_KEY_HEX ?? "", "hex"), keyRef: "fictional-sealer:acceptance" },
  });
  try {
    const reply = await host.progressService(host.contextFor(command.learner), command.body);
    process.stdout.write(JSON.stringify({ pid: process.pid, fresh: host.fresh, reply }) + "\n");
  } finally { await host.close(); }
}
main().catch(error => { process.stderr.write(String(error instanceof Error ? error.message : error) + "\n"); process.exit(1); });
