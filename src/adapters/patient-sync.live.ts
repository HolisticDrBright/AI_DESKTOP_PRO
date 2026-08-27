if (typeof window !== "undefined") {
  throw new Error("This module is server-only and must not run in the browser.");
}
import { resolveOrgId } from "./config";
import { getClinicalAccessToken } from "./session.server";
import { clinicalRpc } from "./aws-clinical-data.server";
import type {
  LiveOrgSyncOperations,
  LivePatientSync,
  LiveSyncMutationResult,
  LiveSyncOutboundResourceType,
  LiveSyncScope,
} from "./live-types";

/**
 * Live patient-sync gateway namespace (server-only).
 *
 * Every call is a Desktop-owned RPC executed as the signed-in user; the
 * database enforces membership, patient access, the connection state machine,
 * consent scopes, idempotency, and — above all — that NOTHING is marked
 * delivered or acknowledged without provider evidence recorded through the
 * service_role worker boundary. The worker RPCs (verify_sync_invitation,
 * claim_sync_outbound, record_sync_delivery, record_sync_inbound) are NOT
 * reachable from here: authenticated execution on them is revoked.
 */
export const patientSyncLive = {
  async overview(patientId: string, sessionToken?: string | null): Promise<LivePatientSync> {
    const token = await getClinicalAccessToken(sessionToken);
    return clinicalRpc<LivePatientSync>(
      "get_patient_sync_overview",
      { _patient_id: patientId },
      token,
    );
  },

  async orgOperations(
    organizationId?: string | null,
    sessionToken?: string | null,
  ): Promise<LiveOrgSyncOperations> {
    const token = await getClinicalAccessToken(sessionToken);
    return clinicalRpc<LiveOrgSyncOperations>(
      "get_org_sync_operations",
      { _organization_id: resolveOrgId(organizationId) },
      token,
    );
  },

  /** The raw token appears ONLY in this response; the server keeps a hash. */
  async createInvitation(
    patientId: string,
    organizationId?: string | null,
    sessionToken?: string | null,
  ): Promise<LiveSyncMutationResult> {
    const token = await getClinicalAccessToken(sessionToken);
    return clinicalRpc<LiveSyncMutationResult>(
      "create_sync_invitation",
      { _organization_id: resolveOrgId(organizationId), _patient_id: patientId },
      token,
    );
  },

  async connectionAction(
    input: {
      connectionId: string;
      action: "pause" | "resume" | "revoke";
      expectedVersion: number;
      reason?: string | null;
    },
    sessionToken?: string | null,
  ): Promise<LiveSyncMutationResult> {
    const token = await getClinicalAccessToken(sessionToken);
    if (input.action === "revoke") {
      return clinicalRpc<LiveSyncMutationResult>(
        "revoke_sync_connection",
        {
          _connection_id: input.connectionId,
          _expected_version: input.expectedVersion,
          _reason: input.reason ?? "",
        },
        token,
      );
    }
    return clinicalRpc<LiveSyncMutationResult>(
      input.action === "pause" ? "pause_sync_connection" : "resume_sync_connection",
      { _connection_id: input.connectionId, _expected_version: input.expectedVersion },
      token,
    );
  },

  async setConsentScope(
    input: {
      connectionId: string;
      scope: LiveSyncScope;
      grant: boolean;
      artifactTitle?: string | null;
      artifactVersion?: string | null;
      jurisdiction?: string | null;
      method?: string;
      authority?: string;
    },
    sessionToken?: string | null,
  ): Promise<LiveSyncMutationResult> {
    const token = await getClinicalAccessToken(sessionToken);
    return clinicalRpc<LiveSyncMutationResult>(
      "set_sync_consent_scope",
      {
        _connection_id: input.connectionId,
        _scope: input.scope,
        _grant: input.grant,
        _artifact_title: input.artifactTitle ?? null,
        _artifact_version: input.artifactVersion ?? null,
        _jurisdiction: input.jurisdiction ?? null,
        _method: input.method ?? "in_person",
        _authority: input.authority ?? "self",
      },
      token,
    );
  },

  /** Payload is built SERVER-side; sending fails closed without a provider. */
  async queueExport(
    input: {
      connectionId: string;
      resourceType: LiveSyncOutboundResourceType;
      resourceId: string;
    },
    sessionToken?: string | null,
  ): Promise<LiveSyncMutationResult> {
    const token = await getClinicalAccessToken(sessionToken);
    return clinicalRpc<LiveSyncMutationResult>(
      "queue_sync_export",
      {
        _connection_id: input.connectionId,
        _resource_type: input.resourceType,
        _resource_id: input.resourceId,
      },
      token,
    );
  },

  async withdrawResource(
    input: {
      connectionId: string;
      resourceType: LiveSyncOutboundResourceType;
      resourceId: string;
      reason: string;
    },
    sessionToken?: string | null,
  ): Promise<LiveSyncMutationResult> {
    const token = await getClinicalAccessToken(sessionToken);
    return clinicalRpc<LiveSyncMutationResult>(
      "withdraw_sync_resource",
      {
        _connection_id: input.connectionId,
        _resource_type: input.resourceType,
        _resource_id: input.resourceId,
        _reason: input.reason,
      },
      token,
    );
  },

  /** Manual retry is authorized, reasoned, and audited. */
  async retryEvent(
    eventId: string,
    reason: string,
    sessionToken?: string | null,
  ): Promise<LiveSyncMutationResult> {
    const token = await getClinicalAccessToken(sessionToken);
    return clinicalRpc<LiveSyncMutationResult>(
      "retry_sync_event",
      { _event_id: eventId, _reason: reason },
      token,
    );
  },

  /** Reasoned discard of queued/failed/dead-letter work; audited. */
  async cancelEvent(
    eventId: string,
    reason: string,
    sessionToken?: string | null,
  ): Promise<LiveSyncMutationResult> {
    const token = await getClinicalAccessToken(sessionToken);
    return clinicalRpc<LiveSyncMutationResult>(
      "cancel_sync_event",
      { _event_id: eventId, _reason: reason },
      token,
    );
  },

  /** Resolution decides direction; it never mutates either original. */
  async resolveConflict(
    input: {
      conflictId: string;
      resolution:
        | "resolved_keep_desktop"
        | "resolved_keep_external"
        | "resolved_manual"
        | "dismissed";
      note: string;
      expectedVersion: number;
    },
    sessionToken?: string | null,
  ): Promise<LiveSyncMutationResult> {
    const token = await getClinicalAccessToken(sessionToken);
    return clinicalRpc<LiveSyncMutationResult>(
      "resolve_sync_conflict",
      {
        _conflict_id: input.conflictId,
        _resolution: input.resolution,
        _note: input.note,
        _expected_version: input.expectedVersion,
      },
      token,
    );
  },

  async reviewInbound(
    input: { eventId: string; action: "accept" | "reject"; note?: string | null },
    sessionToken?: string | null,
  ): Promise<LiveSyncMutationResult> {
    const token = await getClinicalAccessToken(sessionToken);
    return clinicalRpc<LiveSyncMutationResult>(
      "review_sync_inbound",
      { _event_id: input.eventId, _action: input.action, _note: input.note ?? null },
      token,
    );
  },

  /** Versioned overlay over an inbound original — never a mutation of it. */
  async recordCorrection(
    input: { inboundEventId: string; overlay: Record<string, unknown>; reason: string },
    sessionToken?: string | null,
  ): Promise<LiveSyncMutationResult> {
    const token = await getClinicalAccessToken(sessionToken);
    return clinicalRpc<LiveSyncMutationResult>(
      "record_sync_inbound_correction",
      { _inbound_event_id: input.inboundEventId, _overlay: input.overlay, _reason: input.reason },
      token,
    );
  },
};
