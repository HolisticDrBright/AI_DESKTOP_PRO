import { InventoryQualificationError } from './inventory-qualification-artifacts';
import { runInventoryIdentityConfigurationCommand } from './inventory-qualification-identity-configuration-command';
async function main() {
  try { console.log(JSON.stringify(await runInventoryIdentityConfigurationCommand(process.argv.slice(2)))); }
  catch (error) {
    console.error(JSON.stringify({ status: 'not_completed', category: error instanceof InventoryQualificationError
      ? error.category : 'identity_configuration_observation_failed', identityConfigurationVerified: false, privateFixtureSignupVerified: false,
      designatedSyntheticSubjectsVerified: false, databaseIdentityAuthorityVerified: false, physicalLoginVerified: false,
      liveFleetVerified: false, acceptance: false, phiAllowed: false, mutations: false }));
    process.exitCode = 1;
  }
}
void main();
