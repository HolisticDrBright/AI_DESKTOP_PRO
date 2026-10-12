if (typeof window !== "undefined") throw new Error("aws-ask-alp-trusted-context is server-only");

import type { ProductionClinicalRequestContext } from "./aws-identity-consent";
import { buildOwnedChatContext } from "./owned-chat-context";
import { createOwnedConsumerRecordsAdapter, OwnedStorageError, OWNED_STORAGE_SCOPES, type OwnedStorageScope } from "./owned-consumer-records";
import type { KnowledgeLoader } from "./aws-reviewed-knowledge";
import type { TrustedAskAlpContextLoader } from "./aws-ask-alp-api";
import { ownerChatContextDigest } from "./owner-chat-context-digest";

/** A server-owned, consent-filtered snapshot for one verified consumer identity.
 * Re-read before delivery so withdrawal or record changes withhold a stale answer. */
export function createOwnedAskAlpContextLoader(input: {
  adapter: () => ReturnType<typeof createOwnedConsumerRecordsAdapter>;
  allowedScopes: readonly OwnedStorageScope[];
  knowledgeLoader?: KnowledgeLoader;
  now?: () => number;
}): TrustedAskAlpContextLoader {
  if (!input.allowedScopes.includes("ai_context")
    || input.allowedScopes.some((scope) => !OWNED_STORAGE_SCOPES.includes(scope))) throw new Error("ask_alp_context_configuration_invalid");
  return async (identity: ProductionClinicalRequestContext) => {
    const now = input.now?.() ?? Date.now();
    const collect = () => buildOwnedChatContext(input.adapter(), identity, input.allowedScopes, now, input.knowledgeLoader);
    const context = await collect();
    const initialDigest = ownerChatContextDigest(context);
    return {
      context,
      assertCurrent: async () => {
        const current = await collect();
        if (ownerChatContextDigest(current) !== initialDigest) throw new OwnedStorageError("storage_unavailable");
      },
    };
  };
}
