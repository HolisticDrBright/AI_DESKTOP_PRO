if (typeof window !== "undefined") throw new Error("Fullscript practitioner reservations are server-only.");

import { createHash } from "node:crypto";
import { FullscriptUnavailableError } from "./client";
import type { StoredFullscriptConnection } from "./token-store";

/**
 * One Desktop account per Fullscript practitioner (owner decision, 2026-10-16): `fullscript-owner/1`.
 *
 * A practitioner is identified by the Fullscript resource owner the token exchange names, within one Fullscript
 * environment (the sandbox and production are separate Fullscript systems). Its reservation is one item in the token
 * table, keyed by a fingerprint of the two, never by the raw provider id. It names the token row that holds the
 * practitioner (`ownerPk`/`ownerSk`, the clinic and the account's key) and the connection it was taken for
 * (`connectedAt`). It holds no token.
 *
 *   - **Taken** in the install's own transaction (connection-admission.ts): free, or already this account's. A
 *     reservation naming another account cancels the transaction, so the second account's token is never saved.
 *   - **Released** only for the exact connection it names: by a confirmed disconnect, in the same transaction as the row
 *     delete (token-store.ts), or by the reconciler once Fullscript confirms the revocation of a queued token
 *     (membership-generation.ts). A superseded or queued row keeps the practitioner until then.
 *   - **Moved** only by the reviewed, BLOCKED operator transfer (practitioner-ownership.ts), never implicitly.
 */
export const FULLSCRIPT_OWNER_PROTOCOL = "fullscript-owner/1";
const OWNER_ID = /^[A-Za-z0-9-]{16,128}$/;

export function practitionerFingerprint(environment: StoredFullscriptConnection["environment"], ownerId: string): string {
  if ((environment !== "sandbox_us" && environment !== "production_us") || !OWNER_ID.test(ownerId)) throw new FullscriptUnavailableError();
  return createHash("sha256").update(`${FULLSCRIPT_OWNER_PROTOCOL}\u0000${environment}\u0000${ownerId}`).digest("hex");
}
export const fullscriptOwnershipKey = (environment: StoredFullscriptConnection["environment"], ownerId: string) =>
  ({ pk: `FULLSCRIPT_OWNER#${practitionerFingerprint(environment, ownerId)}`, sk: "OWNER" });
export const ownershipKeyOf = (connection: Pick<StoredFullscriptConnection, "environment" | "resourceOwner">) =>
  fullscriptOwnershipKey(connection.environment, connection.resourceOwner.id);
export const tokenRowKeyOf = (connection: Pick<StoredFullscriptConnection, "organizationId" | "actorKey">) =>
  ({ pk: `ORG#${connection.organizationId}`, sk: `FULLSCRIPT#${connection.actorKey}` });

export type OwnershipReservation = {
  pk: string; sk: "OWNER"; protocol: typeof FULLSCRIPT_OWNER_PROTOCOL; ownerPk: string; ownerSk: string;
  /** The connection the reservation was taken for; null after a reviewed transfer, until the named account installs. */
  connectedAt: string | null; reservedAt: string;
  transfer?: { from: string; reviewedBy: string; reason: string; at: string };
};
export function reservationFor(connection: StoredFullscriptConnection, at: string): OwnershipReservation {
  const owner = tokenRowKeyOf(connection);
  return { ...ownershipKeyOf(connection), sk: "OWNER", protocol: FULLSCRIPT_OWNER_PROTOCOL, ownerPk: owner.pk, ownerSk: owner.sk,
    connectedAt: connection.connectedAt, reservedAt: at };
}
/** Taking it: free, or already this account's (its own reconnect, or a reviewed transfer to it). */
export const RESERVE_CONDITION = "attribute_not_exists(pk) OR (ownerPk = :ownerPk AND ownerSk = :ownerSk)";
/** Releasing it: only the exact connection it was taken for. */
export const RELEASE_CONDITION = "ownerPk = :ownerPk AND ownerSk = :ownerSk AND connectedAt = :connectedAt";
export const releaseValues = (connection: StoredFullscriptConnection) => {
  const owner = tokenRowKeyOf(connection);
  return { ":ownerPk": owner.pk, ":ownerSk": owner.sk, ":connectedAt": connection.connectedAt };
};
export const namesConnection = (reservation: Record<string, unknown> | undefined, connection: StoredFullscriptConnection) => {
  const owner = tokenRowKeyOf(connection);
  return reservation?.ownerPk === owner.pk && reservation.ownerSk === owner.sk && reservation.connectedAt === connection.connectedAt;
};

/**
 * This Fullscript practitioner is already connected to another Desktop account (in this clinic or another). Nothing is
 * saved for this account, and the other connection is not changed. Moving a practitioner means disconnecting it there,
 * or a reviewed operator transfer; never a silent replacement.
 */
export class FullscriptPractitionerConnectedElsewhereError extends FullscriptUnavailableError {
  constructor() {
    super("This Fullscript practitioner account is already connected to another Desktop account.");
    this.name = "FullscriptPractitionerConnectedElsewhereError";
  }
}
/**
 * The install's reply was lost and could not be confirmed either way: it may have committed. The caller does not
 * guess. The token is queued for the reconciler, which revokes it only if no saved connection holds it.
 */
export class FullscriptInstallUnconfirmedError extends FullscriptUnavailableError {
  constructor() {
    super("The Fullscript connection could not be confirmed.");
    this.name = "FullscriptInstallUnconfirmedError";
  }
}
