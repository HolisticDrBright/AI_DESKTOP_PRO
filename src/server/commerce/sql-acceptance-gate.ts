import { isContractFixtureAllowed } from "../runtime/contractFixture";

/**
 * The SQL acceptance host's gate (sql-acceptance-host.ts): a SEPARATELY configured fictional test
 * target. It exists only where the local contract fixture admits this process (never a deployment)
 * AND `COMMERCE_SQL_ACCEPTANCE=1`. Kept apart from the host so a route module can ask the question
 * without importing the embedded database.
 */
export const SQL_ACCEPTANCE_FLAG = "COMMERCE_SQL_ACCEPTANCE";
export function sqlAcceptanceAllowed(env: Record<string, string | undefined> = process.env): boolean {
  return isContractFixtureAllowed(env as never) && env[SQL_ACCEPTANCE_FLAG] === "1";
}
