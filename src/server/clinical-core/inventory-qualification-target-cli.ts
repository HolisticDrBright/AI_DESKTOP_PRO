import { InventoryQualificationError } from './inventory-qualification-artifacts';
import { checkInventoryQualificationConfiguration } from './inventory-qualification-configuration';

try { console.log(JSON.stringify(checkInventoryQualificationConfiguration(process.argv.slice(2)))); }
catch (error) {
  console.error(JSON.stringify({ status: 'not_completed', category: error instanceof InventoryQualificationError ? error.category : 'configuration_check_failed',
    configurationChecked: false, liveTargetVerified: false, reviewVerified: false, acceptance: false, deploymentPerformed: false, phiAllowed: false }));
  process.exitCode = 1;
}
