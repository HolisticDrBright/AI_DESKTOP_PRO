import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const api = readFileSync("src/server/clinical-core/aws-lab-analysis-api.ts", "utf8");
const cleanup = readFileSync("src/server/clinical-core/lab-deletion-cleanup.ts", "utf8");
const template = JSON.parse(readFileSync("infra/aws-clinical-core/lab-analysis-extension.json", "utf8"));

describe("AWS lab deletion boundary", () => {
  test("exposes deletion only behind the existing consumer JWT authorizer", () => {
    const route = template.Resources.DeleteLabJobRoute.Properties;
    expect(route.RouteKey).toBe("DELETE /clinical-core/consumer/labs/jobs/{jobId}");
    expect(route.AuthorizationType).toBe("JWT");
    expect(route.AuthorizerId.Ref).toBe("LabConsumerAuthorizer");
    const appSessionRoute = template.Resources.DeleteLabJobSyntheticSessionRoute.Properties;
    expect(appSessionRoute.RouteKey).toBe("DELETE /clinical-core/synthetic-session/labs/jobs/{jobId}");
    expect(appSessionRoute.AuthorizationType).toBe("CUSTOM");
    expect(appSessionRoute.AuthorizerId.Ref).toBe("LabSyntheticSessionAuthorizer");
  });

  test("checks ownership, refuses active jobs, and purges source plus artifact versions", () => {
    expect(api).toContain("const job = await ownedJob(jobId, identity)");
    expect(api).toContain('["awaiting_upload", "completed", "needs_review", "failed", "deleting"]');
    expect(cleanup).toContain("ListObjectVersionsCommand");
    expect(cleanup).toContain("DeleteObjectsCommand");
    expect(cleanup).toContain("synthetic-labs/artifacts/${jobId}/");
    expect(cleanup).toContain('organizationId = :org AND personId = :person');
    expect(cleanup).toContain('#state = :deleting');
    expect(api).toContain('claimLabDeletion');
    expect(api).toContain('reconcileLabDeletion');
  });

  test("grants only the delete and version-list permissions needed by the API", () => {
    const policies = template.Resources.LabApiRole.Properties.Policies;
    const source = JSON.stringify(policies);
    expect(source).toContain("dynamodb:DeleteItem");
    expect(source).toContain("s3:DeleteObjectVersion");
    expect(source).toContain("s3:ListBucketVersions");
    expect(template.Outputs.RoutesEnabled.Value).toBe("28");
  });
});
