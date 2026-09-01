import { NextRequest } from "next/server";
import { relationshipsLive } from "@/adapters/relationships.live";
import { AdapterError } from "@/adapters/errors";
import {
  PATIENT_RELATIONSHIP_SCOPES,
  PATIENT_RELATIONSHIP_TYPES,
  type LivePatientRelationshipScope,
  type LivePatientRelationshipType,
} from "@/adapters/live-types";
import { getRequestSession } from "@/server/session";
import { liveGuard, runLive } from "../../route-helpers";

type Body = Record<string, unknown>;

function requiredString(body: Body, key: string, maxLength: number): string {
  const value = body[key];
  if (typeof value !== "string" || value.trim().length < 1 || value.length > maxLength) {
    throw new AdapterError("invalid", "Complete all required relationship fields.");
  }
  return value.trim();
}

/** POST handles list, invitation, and revocation without exposing clinical credentials to the browser. */
export async function POST(req: NextRequest) {
  const blocked = liveGuard();
  if (blocked) return blocked;
  return runLive(async () => {
    const body = (await req.json().catch(() => ({}))) as Body;
    const action = requiredString(body, "action", 16);
    const session = await getRequestSession();
    const syntheticOnly = process.env.APP_RUNTIME_ENV === "staging"
      || process.env.CLINICAL_DATA_PLANE === "supabase_staging";

    if (action === "list") {
      const result = await relationshipsLive.list(requiredString(body, "patientId", 36), session.token, session.orgId);
      return { ...result, syntheticOnly };
    }
    if (action === "invite") {
      if (syntheticOnly && body.attestsSynthetic !== true) {
        throw new AdapterError("invalid", "Confirm that this relationship uses synthetic test identities only.");
      }
      const relationshipType = requiredString(body, "relationshipType", 32) as LivePatientRelationshipType;
      const requestedScopes = body.requestedScopes;
      const expiresInDays = body.expiresInDays;
      if (!PATIENT_RELATIONSHIP_TYPES.includes(relationshipType)
        || !Array.isArray(requestedScopes)
        || requestedScopes.length < 1
        || requestedScopes.length > PATIENT_RELATIONSHIP_SCOPES.length
        || requestedScopes.some((scope) => typeof scope !== "string"
          || !PATIENT_RELATIONSHIP_SCOPES.includes(scope as LivePatientRelationshipScope))
        || ![30, 90, 365].includes(expiresInDays as number)) {
        throw new AdapterError("invalid", "Choose a relationship, at least one access area, and an expiration.");
      }
      return relationshipsLive.invite({
        patientId: requiredString(body, "patientId", 36),
        displayName: requiredString(body, "displayName", 120),
        email: requiredString(body, "email", 320).toLowerCase(),
        relationshipType,
        requestedScopes: [...new Set(requestedScopes)] as LivePatientRelationshipScope[],
        expiresInDays: expiresInDays as 30 | 90 | 365,
      }, session.token, session.orgId);
    }
    if (action === "revoke") {
      const expectedVersion = body.expectedVersion;
      if (!Number.isInteger(expectedVersion) || (expectedVersion as number) < 1) {
        throw new AdapterError("invalid", "The relationship version is invalid. Refresh and try again.");
      }
      return relationshipsLive.revoke({
        relationshipId: requiredString(body, "relationshipId", 36),
        expectedVersion: expectedVersion as number,
        reason: requiredString(body, "reason", 500),
      }, session.token);
    }
    throw new AdapterError("invalid", "Unknown relationship action.");
  });
}

if (typeof window !== "undefined") {
  throw new Error("This module is server-only and must not run in the browser.");
}
