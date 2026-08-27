if (typeof window !== "undefined") {
  throw new Error("This module is server-only and must not run in the browser.");
}
import { resolveOrgId } from "./config";
import { getClinicalAccessToken } from "./session.server";
import { clinicalRpc } from "./aws-clinical-data.server";
import type {
  LiveConversation,
  LiveInbox,
  LiveInboxFilters,
  LiveInboxMutationResult,
  LiveInboxTodaySummary,
  LiveMessageChannel,
  LivePatientMessages,
  LiveThreadCategory,
  LiveThreadPriority,
} from "./live-types";

/**
 * Live inbox + messaging namespace (server-only).
 *
 * Every call is a Desktop-owned RPC executed as the signed-in user, so the
 * database enforces membership, patient access, the thread and message state
 * machines, consent and preferences, sender identity (always auth.uid() —
 * there is no sender parameter to spoof), and delivery evidence.
 *
 * Boundaries this namespace can NEVER cross, because the RPCs have no such
 * code path: nothing here contacts a delivery provider (send refuses without
 * a registered one and keeps the draft), marks a message sent/delivered
 * without provider acknowledgment, sends from AI output, authorizes a refill,
 * diagnoses, orders, prescribes, schedules, charges, or signs a note.
 */
export const inboxLive = {
  async list(
    filters: LiveInboxFilters,
    organizationId?: string | null,
    sessionToken?: string | null,
  ): Promise<LiveInbox> {
    const token = await getClinicalAccessToken(sessionToken);
    const orgId = resolveOrgId(organizationId);
    return clinicalRpc<LiveInbox>(
      "list_inbox",
      {
        _organization_id: orgId,
        _query: filters.query ?? null,
        _category: filters.category ?? null,
        _priority: filters.priority ?? null,
        _status: filters.status ?? null,
        _queue: filters.queue ?? null,
        _assigned_to_me: filters.assignedToMe ?? false,
        _unread_only: filters.unreadOnly ?? false,
        _due_only: filters.dueOnly ?? false,
        _limit: filters.limit ?? 50,
      },
      token,
    );
  },

  async getThread(
    conversationId: string,
    sessionToken?: string | null,
  ): Promise<LiveConversation> {
    const token = await getClinicalAccessToken(sessionToken);
    return clinicalRpc<LiveConversation>(
      "get_conversation",
      { _conversation_id: conversationId },
      token,
    );
  },

  async createThread(
    input: {
      patientId: string;
      subject: string;
      category?: LiveThreadCategory;
      priority?: LiveThreadPriority;
    },
    organizationId?: string | null,
    sessionToken?: string | null,
  ): Promise<LiveInboxMutationResult> {
    const token = await getClinicalAccessToken(sessionToken);
    const orgId = resolveOrgId(organizationId);
    return clinicalRpc<LiveInboxMutationResult>(
      "create_conversation",
      {
        _organization_id: orgId,
        _patient_id: input.patientId,
        _subject: input.subject,
        _category: input.category ?? "general",
        _priority: input.priority ?? "normal",
      },
      token,
    );
  },

  /** The sender is ALWAYS the authenticated caller; drafts are versioned. */
  async saveDraft(
    input: {
      conversationId: string;
      body: string;
      messageId?: string | null;
      expectedVersion?: number | null;
    },
    sessionToken?: string | null,
  ): Promise<LiveInboxMutationResult> {
    const token = await getClinicalAccessToken(sessionToken);
    return clinicalRpc<LiveInboxMutationResult>(
      "save_message_draft",
      {
        _conversation_id: input.conversationId,
        _body: input.body,
        _message_id: input.messageId ?? null,
        _expected_version: input.expectedVersion ?? null,
      },
      token,
    );
  },

  async cancelDraft(
    messageId: string,
    sessionToken?: string | null,
  ): Promise<LiveInboxMutationResult> {
    const token = await getClinicalAccessToken(sessionToken);
    return clinicalRpc<LiveInboxMutationResult>(
      "cancel_message_draft",
      { _message_id: messageId },
      token,
    );
  },

  /**
   * FAIL-CLOSED SENDING. Consent/preferences are enforced server-side, and
   * with no registered provider the RPC returns {ok:false, refusal:
   * 'provider_not_configured'} with the draft kept — nothing is marked
   * queued, sent, or delivered.
   */
  async send(
    input: { messageId: string; channel?: LiveMessageChannel; idempotencyKey?: string | null },
    sessionToken?: string | null,
  ): Promise<LiveInboxMutationResult> {
    const token = await getClinicalAccessToken(sessionToken);
    return clinicalRpc<LiveInboxMutationResult>(
      "send_message",
      {
        _message_id: input.messageId,
        _channel: input.channel ?? "alp_in_app",
        _idempotency_key: input.idempotencyKey ?? null,
      },
      token,
    );
  },

  async markRead(
    conversationId: string,
    sessionToken?: string | null,
  ): Promise<LiveInboxMutationResult> {
    const token = await getClinicalAccessToken(sessionToken);
    return clinicalRpc<LiveInboxMutationResult>(
      "mark_conversation_read",
      { _conversation_id: conversationId },
      token,
    );
  },

  /** Assignment / queue / priority / category / status machine / follow-up. */
  async workflow(
    input: {
      conversationId: string;
      action: "assign" | "queue" | "priority" | "category" | "status" | "follow_up";
      expectedVersion: number;
      value?: string | null;
      at?: string | null;
      note?: string | null;
    },
    sessionToken?: string | null,
  ): Promise<LiveInboxMutationResult> {
    const token = await getClinicalAccessToken(sessionToken);
    return clinicalRpc<LiveInboxMutationResult>(
      "update_conversation_workflow",
      {
        _conversation_id: input.conversationId,
        _action: input.action,
        _expected_version: input.expectedVersion,
        _value: input.value ?? null,
        _at: input.at ?? null,
        _note: input.note ?? null,
      },
      token,
    );
  },

  /** Idempotent conversion into a REAL review-queue task. */
  async createTask(
    input: { messageId: string; title?: string | null; priority?: "low" | "medium" | "high" },
    sessionToken?: string | null,
  ): Promise<LiveInboxMutationResult> {
    const token = await getClinicalAccessToken(sessionToken);
    return clinicalRpc<LiveInboxMutationResult>(
      "create_task_from_message",
      {
        _message_id: input.messageId,
        _title: input.title ?? null,
        _priority: input.priority ?? "medium",
      },
      token,
    );
  },

  /** Quoted content into an UNSIGNED draft note; practitioner-gated; never signs. */
  async appendToNote(
    input: { messageId: string; encounterId: string; section?: string },
    sessionToken?: string | null,
  ): Promise<LiveInboxMutationResult> {
    const token = await getClinicalAccessToken(sessionToken);
    return clinicalRpc<LiveInboxMutationResult>(
      "append_message_to_note",
      {
        _message_id: input.messageId,
        _encounter_id: input.encounterId,
        _section: input.section ?? "subjective",
      },
      token,
    );
  },

  async setPreferences(
    input: {
      patientId: string;
      preferredChannel?: "in_app" | "email" | "sms" | "none";
      emailOk?: boolean;
      smsOk?: boolean;
      pushOk?: boolean;
      doNotContact?: boolean;
      consentId?: string | null;
      note?: string | null;
    },
    sessionToken?: string | null,
  ): Promise<LiveInboxMutationResult> {
    const token = await getClinicalAccessToken(sessionToken);
    return clinicalRpc<LiveInboxMutationResult>(
      "set_communication_preferences",
      {
        _patient_id: input.patientId,
        _preferred_channel: input.preferredChannel ?? "in_app",
        _email_ok: input.emailOk ?? false,
        _sms_ok: input.smsOk ?? false,
        _push_ok: input.pushOk ?? false,
        _do_not_contact: input.doNotContact ?? false,
        _consent_id: input.consentId ?? null,
        _note: input.note ?? null,
      },
      token,
    );
  },

  /** Metadata + opaque reference only; no bytes, no URLs. */
  async registerAttachment(
    input: {
      conversationId: string;
      fileName: string;
      contentType: string;
      byteSize?: number | null;
      messageId?: string | null;
    },
    sessionToken?: string | null,
  ): Promise<LiveInboxMutationResult> {
    const token = await getClinicalAccessToken(sessionToken);
    return clinicalRpc<LiveInboxMutationResult>(
      "register_message_attachment",
      {
        _conversation_id: input.conversationId,
        _file_name: input.fileName,
        _content_type: input.contentType,
        _byte_size: input.byteSize ?? null,
        _sha256: null,
        _message_id: input.messageId ?? null,
      },
      token,
    );
  },

  /** The ONLY path from AI output to action; a human decision, applied guarded. */
  async reviewAiSuggestion(
    reviewId: string,
    decision: "accept" | "dismiss",
    sessionToken?: string | null,
  ): Promise<LiveInboxMutationResult> {
    const token = await getClinicalAccessToken(sessionToken);
    return clinicalRpc<LiveInboxMutationResult>(
      "review_ai_suggestion",
      { _review_id: reviewId, _decision: decision },
      token,
    );
  },

  async getPatientMessages(
    patientId: string,
    sessionToken?: string | null,
  ): Promise<LivePatientMessages> {
    const token = await getClinicalAccessToken(sessionToken);
    return clinicalRpc<LivePatientMessages>(
      "get_patient_messages",
      { _patient_id: patientId },
      token,
    );
  },

  async todaySummary(
    organizationId?: string | null,
    sessionToken?: string | null,
  ): Promise<LiveInboxTodaySummary> {
    const token = await getClinicalAccessToken(sessionToken);
    const orgId = resolveOrgId(organizationId);
    return clinicalRpc<LiveInboxTodaySummary>(
      "get_inbox_today_summary",
      { _organization_id: orgId },
      token,
    );
  },
};
