if (typeof window !== "undefined") throw new Error("owner-chat-context-digest is server-only");

import { createHash } from "node:crypto";
import { OwnedStorageError } from "./owned-consumer-records";

/** Hash the exact owner snapshot returned by personal storage. This same
 * bounded JSON is rebuilt at generation, so a changed or withdrawn source
 * cannot accompany context chips from an earlier read. */
export function ownerChatContextDigest(context: Record<string, unknown>): string {
  const bytes = Buffer.from(JSON.stringify(context), "utf8");
  if (bytes.byteLength > 60_000) throw new OwnedStorageError("storage_unavailable");
  return createHash("sha256").update(bytes).digest("hex");
}
