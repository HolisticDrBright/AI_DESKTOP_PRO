if (typeof window !== "undefined") {
  throw new Error("This module is server-only and must not run in the browser.");
}

import { resolveOrgId } from "./config";
import { clinicalRpc } from "./aws-clinical-data.server";
import { getClinicalAccessToken } from "./session.server";
import type {
  LivePatientRelationshipInvitationResult,
  LivePatientRelationshipMutationResult,
  LivePatientRelationships,
  LivePatientRelationshipScope,
  LivePatientRelationshipType,
} from "./live-types";

export const relationshipsLive = {
  async list(
    patientId: string,
    sessionToken?: string | null,
    orgId?: string | null,
  ): Promise<LivePatientRelationships> {
    const token = await getClinicalAccessToken(sessionToken);
    return clinicalRpc<LivePatientRelationships>(
      "get_patient_relationships",
      { _organization_id: resolveOrgId(orgId), _patient_id: patientId },
      token,
    );
  },

  async invite(
    input: {
      patientId: string;
      displayName: string;
      email: string;
      relationshipType: LivePatientRelationshipType;
      requestedScopes: LivePatientRelationshipScope[];
      expiresInDays: 30 | 90 | 365;
    },
    sessionToken?: string | null,
    orgId?: string | null,
  ): Promise<LivePatientRelationshipInvitationResult> {
    const token = await getClinicalAccessToken(sessionToken);
    return clinicalRpc<LivePatientRelationshipInvitationResult>(
      "create_patient_relationship_invitation",
      {
        _organization_id: resolveOrgId(orgId),
        _patient_id: input.patientId,
        _display_name: input.displayName,
        _email: input.email,
        _relationship_type: input.relationshipType,
        _requested_scopes: input.requestedScopes,
        _expires_in_days: input.expiresInDays,
      },
      token,
    );
  },

  async revoke(
    input: { relationshipId: string; expectedVersion: number; reason: string },
    sessionToken?: string | null,
  ): Promise<LivePatientRelationshipMutationResult> {
    const token = await getClinicalAccessToken(sessionToken);
    return clinicalRpc<LivePatientRelationshipMutationResult>(
      "revoke_patient_relationship",
      {
        _relationship_id: input.relationshipId,
        _expected_version: input.expectedVersion,
        _reason: input.reason,
      },
      token,
    );
  },
};
