import { describe, expect, it, vi } from "vitest";
import { ASK_ALP_PRIVATE_ROUTE, PrivateAskAlpCallerError, verifyPrivateAskAlpCaller } from "./aws-ask-alp-private-caller";
import type { ApiGatewayV2Event } from "./aws-identity-api";

const token = `${"a".repeat(12)}.${"b".repeat(48)}.${"c".repeat(16)}`;
const config = {
  apiId: "abcdefghij", accountId: "173535830222",
  backendRoleArn: "arn:aws:iam::173535830222:role/alp-v2-production-api",
  consumerIssuer: "https://cognito-idp.us-east-2.amazonaws.com/us-east-2_example",
  consumerAudience: "72aksm2dm4nf03l8d9nrp2dbh0",
};
const claims = { iss: config.consumerIssuer, aud: config.consumerAudience, token_use: "id", sub: "owner-12345678" };
function event(): ApiGatewayV2Event {
  return { routeKey: ASK_ALP_PRIVATE_ROUTE,
    headers: { authorization: "AWS4-HMAC-SHA256 Credential=fictional", "x-alp-consumer-id-token": token },
    requestContext: { apiId: config.apiId, accountId: config.accountId,
      authorizer: { iam: { accountId: config.accountId,
        userArn: "arn:aws:sts::173535830222:assumed-role/alp-v2-production-api/fictional-ecs-task" } } } };
}

describe("private Ask ALP backend and owner authentication", () => {
  it("admits only the pinned IAM role after separately verifying a consumer token", async () => {
    const verify = vi.fn(async () => claims);
    const result = await verifyPrivateAskAlpCaller(event(), config, verify);
    expect(result).toEqual({ claims, consumerAuthorization: `Bearer ${token}` });
    expect(verify).toHaveBeenCalledExactlyOnceWith(token);
  });

  it.each([
    ["missing IAM authority", (e: ApiGatewayV2Event) => { e.requestContext!.authorizer = undefined; }],
    ["different role", (e: ApiGatewayV2Event) => { e.requestContext!.authorizer!.iam!.userArn = "arn:aws:sts::173535830222:assumed-role/other-role/task"; }],
    ["different account", (e: ApiGatewayV2Event) => { e.requestContext!.accountId = "588966314750"; }],
    ["different API", (e: ApiGatewayV2Event) => { e.requestContext!.apiId = "zyxwvutsrq"; }],
    ["public route", (e: ApiGatewayV2Event) => { e.routeKey = "POST /clinical-core/consumer/ask-alp/generate"; }],
    ["browser bearer", (e: ApiGatewayV2Event) => { e.headers!.authorization = `Bearer ${token}`; }],
    ["missing consumer token", (e: ApiGatewayV2Event) => { delete e.headers!["x-alp-consumer-id-token"]; }],
    ["duplicate token header casing", (e: ApiGatewayV2Event) => { e.headers!["X-ALP-CONSUMER-ID-TOKEN"] = token; }],
  ])("refuses %s before token verification", async (_name, mutate) => {
    const candidate = event(); mutate(candidate);
    const verify = vi.fn(async () => claims);
    await expect(verifyPrivateAskAlpCaller(candidate, config, verify)).rejects.toBeInstanceOf(PrivateAskAlpCallerError);
    expect(verify).not.toHaveBeenCalled();
  });

  it("refuses a token whose signature, issuer, audience or expiry fails verification", async () => {
    await expect(verifyPrivateAskAlpCaller(event(), config, async () => { throw new Error("invalid JWT"); }))
      .rejects.toBeInstanceOf(PrivateAskAlpCallerError);
  });

  it("refuses malformed pinned role configuration", async () => {
    await expect(verifyPrivateAskAlpCaller(event(), { ...config, backendRoleArn: "arn:aws:iam::588966314750:role/other" }, async () => claims))
      .rejects.toThrow("ask_alp_private_caller_configuration_invalid");
  });
});
