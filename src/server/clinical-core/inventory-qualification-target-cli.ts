import { InventoryQualificationError } from './inventory-qualification-artifacts';
import { checkInventoryQualificationConfiguration } from './inventory-qualification-configuration';
import { observeInventoryQualificationFleet } from './inventory-qualification-fleet-observer';

async function main() {
  try {
    const args = process.argv.slice(2);
    const report = args[0] === '--observe-fleet' ? await observeInventoryQualificationFleet(args) : checkInventoryQualificationConfiguration(args);
    console.log(JSON.stringify(report));
    if ('status' in report && report.status === 'not_completed') process.exitCode = 1;
  } catch (error) {
    console.error(JSON.stringify({ status: 'not_completed', category: error instanceof InventoryQualificationError ? error.category : 'inventory_observation_failed',
      configurationChecked: false, liveTargetVerified: false, reviewVerified: false, acceptance: false, deploymentPerformed: false, phiAllowed: false }));
    process.exitCode = 1;
  }
}
void main();
