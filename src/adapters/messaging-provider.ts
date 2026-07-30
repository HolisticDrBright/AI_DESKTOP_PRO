/**
 * MESSAGING DELIVERY PROVIDER BOUNDARY (phase 4).
 *
 * The typed contract a future delivery integration must implement — AI
 * Longevity Pro in-app messaging first, then email/SMS/push. This repository
 * ships NO implementation: `resolveMessagingProvider` always returns null, the
 * database's `send_message` refuses independently (a provider must also be
 * registered as a connected `messaging` connector row), and the UI renders
 * "Messaging provider not configured".
 *
 * The durable-outbox contract an implementation plugs into:
 *   1. `send_message` validates consent/preferences, then creates a
 *      `message_outbox` row (status `queued`, unique idempotency key) and
 *      marks the message `queued` — NEVER `sent`.
 *   2. The provider worker claims queued rows, attempts delivery, and reports
 *      through `record_delivery_callback` (service_role): every provider
 *      event carries a unique `providerEventId` (replays dedupe), the
 *      projection only moves forward (queued → sending → sent → delivered),
 *      retryable failures re-queue with backoff, terminal failures mark the
 *      message `failed` with a PHI-safe reason.
 *   3. `sent`/`delivered` are ONLY ever set from those callbacks — delivery
 *      claims always trace to provider acknowledgment.
 *
 * This module is type-level only; importing it never contacts anything.
 */
import type {
  AlpMessagingDeliveryReceiptV1,
  AlpMessagingMessageV1,
  LiveMessageChannel,
} from "./live-types";

export interface MessagingProviderSendRequest {
  /** The outbox row driving this attempt (its idempotency key travels along). */
  outboxId: string;
  idempotencyKey: string;
  channel: Exclude<LiveMessageChannel, "in_app">;
  payload: AlpMessagingMessageV1;
}

export interface MessagingProviderSendResult {
  /** Provider-assigned id used to correlate later callbacks. */
  providerMessageId: string;
  acceptedAt: string;
}

export interface MessagingProvider {
  readonly name: string;
  readonly channels: Exclude<LiveMessageChannel, "in_app">[];
  /** Hand one queued outbox entry to the provider. Must be idempotent per key. */
  send(request: MessagingProviderSendRequest): Promise<MessagingProviderSendResult>;
  /** Verify + normalize a raw callback into the delivery-receipt contract. */
  parseCallback(rawBody: string, signature: string | null): AlpMessagingDeliveryReceiptV1;
}

/**
 * Provider resolution. There is deliberately no registry to populate and no
 * environment variable that could enable a fixture provider in a deployed
 * clinical build — wiring a real provider is a reviewed code change plus a
 * `messaging` connector registration in the database.
 */
export function resolveMessagingProvider(): MessagingProvider | null {
  return null;
}
