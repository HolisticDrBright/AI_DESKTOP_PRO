import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { VerifiedEvent } from "./stripe-boundary";
import { attachProcessorRef, recordBillingWebhook } from "./stripe-processor.server";

function event(overrides: Partial<VerifiedEvent> = {}): VerifiedEvent {
  return {
    id: "evt_test_123",
    type: "payment_intent.succeeded",
    livemode: false,
    created: 1_787_113_600,
    data: {
      object: {
        id: "pi_test_123",
        amount: 12500,
        currency: "usd",
        patient_name: "must never be stored",
        clinical_note: "must never be stored",
      },
    },
    ...overrides,
  };
}

function configure() {
  vi.stubEnv("CLINICAL_AWS_BILLING_LEDGER_TABLE", "ai-clinical-billing-ledger");
  vi.stubEnv("CLINICAL_AWS_REGION", "us-east-2");
}

beforeEach(() => {
  configure();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("AWS billing ledger", () => {
  test("stores only minimum-necessary, PHI-free metadata", async () => {
    const send = vi.spyOn(DynamoDBClient.prototype, "send").mockResolvedValue({} as never);

    await expect(recordBillingWebhook(event())).resolves.toEqual({ outcome: "processed" });
    const command = send.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(PutItemCommand);
    const input = (command as PutItemCommand).input;
    expect(input.ConditionExpression).toBe("attribute_not_exists(pk)");
    expect(input.Item).toMatchObject({
      pk: { S: "EVENT#evt_test_123" },
      event_type: { S: "payment_intent.succeeded" },
      processor_ref: { S: "pi_test_123" },
      amount_minor: { N: "12500" },
      currency: { S: "USD" },
      data_classification: { S: "billing_metadata_no_phi" },
    });
    const serialized = JSON.stringify(input.Item);
    expect(serialized).not.toContain("patient_name");
    expect(serialized).not.toContain("clinical_note");
    expect(serialized).not.toContain("must never be stored");
  });

  test("database conditional refusal is reported as a duplicate", async () => {
    vi.spyOn(DynamoDBClient.prototype, "send").mockRejectedValue(
      Object.assign(new Error("duplicate"), { name: "ConditionalCheckFailedException" }),
    );
    await expect(recordBillingWebhook(event())).resolves.toEqual({ outcome: "duplicate" });
  });

  test("unknown event types are durably marked ignored, never guessed", async () => {
    const send = vi.spyOn(DynamoDBClient.prototype, "send").mockResolvedValue({} as never);
    const result = await recordBillingWebhook(event({ type: "future.unknown_event" }));
    expect(result.outcome).toBe("ignored");
    const command = send.mock.calls[0]?.[0] as PutItemCommand;
    expect(command.input.Item?.outcome).toEqual({ S: "ignored" });
  });

  test("processor references are attach-once and conflicting rebinding refuses", async () => {
    const send = vi.spyOn(DynamoDBClient.prototype, "send").mockResolvedValue({} as never);
    const paymentId = "8b7b6d9a-727e-4f9c-9cc7-108d1319bd42";
    await expect(attachProcessorRef(paymentId, "pi_test_1")).resolves.toBeUndefined();
    const command = send.mock.calls[0]?.[0] as PutItemCommand;
    expect(command.input.ConditionExpression).toContain("attribute_not_exists(pk)");
    expect(command.input.ExpressionAttributeValues).toEqual({ ":processor_ref": { S: "pi_test_1" } });

    send.mockRejectedValueOnce(
      Object.assign(new Error("conflict"), { name: "ConditionalCheckFailedException" }),
    );
    await expect(attachProcessorRef(paymentId, "pi_test_2")).rejects.toThrow(
      "Processor reference conflict",
    );
  });

  test("missing AWS configuration fails closed before a network call", async () => {
    vi.stubEnv("CLINICAL_AWS_BILLING_LEDGER_TABLE", "");
    const send = vi.spyOn(DynamoDBClient.prototype, "send");
    await expect(recordBillingWebhook(event())).rejects.toThrow("not configured");
    expect(send).not.toHaveBeenCalled();
  });
});
