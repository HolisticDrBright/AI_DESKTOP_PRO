import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// This snapshot is an inventory tripwire, not evidence that the routes have
// current membership authority or are deployed. Review each changed route
// against docs/workforce-membership-authority-decision-2026-10-15.md.
const EXPECTED: Readonly<Record<string, { count: number; routeDigest: string }>> = {
  "catalog-api-extension.json": { count: 2, routeDigest: "9dbfd13ced6ee1080ffc23ab493dd1373f8289c710b5c9c5d03788c6c1af5bfc" },
  "identity-api-extension.json": { count: 27, routeDigest: "2ed477b79ccfcd6362ceb37272bb20679976b6b27e65df19485e8164e5103178" },
  "production-clinical-api-candidate.json": { count: 9, routeDigest: "a16aaff34b883db2b4b332791771059fe1bde9ccb4bd6a7137f3d07b8845fc99" },
  "production-clinical-api-disabled.json": { count: 1, routeDigest: "5d42d3dd8e834a38864a43b8397a914066954411421db0b9f0ea3443e46dcd07" },
  "qualification-program-api-candidate.json": { count: 1, routeDigest: "63dc618177aac7f1fd6ae3a3b0a79041260aa5259de3a9769ea40fad00c3a95d" },
  "qualification-program-api-successor.json": { count: 1, routeDigest: "63dc618177aac7f1fd6ae3a3b0a79041260aa5259de3a9769ea40fad00c3a95d" },
  "telehealth-requests-extension.json": { count: 17, routeDigest: "ad21d7a35fe1d5f98cf9fd62fbb88e3519bb4f8d1bc8499bed6ed6933a559e2e" },
};

type TemplateRoute = {
  Type?: string;
  Properties?: {
    RouteKey?: unknown;
    AuthorizationType?: unknown;
    AuthorizerId?: unknown;
    JwtConfiguration?: { Issuer?: unknown };
  };
};
type Template = { Resources?: Record<string, TemplateRoute> };
const templateDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../../../infra/aws-clinical-core");

function actualWorkforceRoutes(): Record<string, { count: number; routeDigest: string }> {
  const result: Record<string, { count: number; routeDigest: string }> = {};
  for (const filename of readdirSync(templateDirectory).filter((name) => name.endsWith(".json")).sort()) {
    const template = JSON.parse(readFileSync(join(templateDirectory, filename), "utf8")) as Template;
    const routes: string[] = [];
    const authorizers = template.Resources ?? {};
    for (const resource of Object.values(template.Resources ?? {})) {
      if (resource.Type !== "AWS::ApiGatewayV2::Route") continue;
      // A dynamic route key cannot be proven absent from the workforce surface.
      expect(typeof resource.Properties?.RouteKey, `${filename}: route key must be literal`).toBe("string");
      const key = resource.Properties?.RouteKey as string;
      const authorizerRef = resource.Properties?.AuthorizerId as { Ref?: string } | undefined;
      const issuer = authorizerRef?.Ref
        ? authorizers[authorizerRef.Ref]?.Properties?.JwtConfiguration?.Issuer
        : undefined;
      const issuerSource = typeof issuer === "object" && issuer !== null
        ? (issuer as { "Fn::Sub"?: unknown })["Fn::Sub"]
        : undefined;
      const workforceAuthorizer = typeof issuerSource === "string" && issuerSource.includes("${WorkforceUserPoolId}");
      // Route naming and the issuer must agree in both directions. Otherwise
      // an innocently named route can bypass this inventory's path filter.
      expect(workforceAuthorizer, `${filename}: ${key} workforce path/issuer mismatch`)
        .toBe(key.includes("/workforce/"));
      if (workforceAuthorizer) {
        expect(resource.Properties?.AuthorizationType, `${filename}: ${key} requires JWT`).toBe("JWT");
        routes.push(key);
      }
    }
    if (routes.length) {
      routes.sort();
      result[filename] = {
        count: routes.length,
        routeDigest: createHash("sha256").update(JSON.stringify(routes)).digest("hex"),
      };
    }
  }
  return result;
}

describe("workforce route authority inventory", () => {
  it("refuses an unreviewed addition, removal or rename in any top-level clinical-core template", () => {
    const actual = actualWorkforceRoutes();
    expect(actual).toEqual(EXPECTED);
    expect(Object.values(actual).reduce((total, item) => total + item.count, 0)).toBe(58);
  });
});
