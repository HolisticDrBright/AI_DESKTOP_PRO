-- Preserve the complete sync-worker audit vocabulary while adding the
-- protocol-template and interaction-review events introduced in 20260826110000.

alter table clinical_audit.events drop constraint events_action_check;
alter table clinical_audit.events add constraint events_action_check check(action in(
  'connection.invitation_issued','connection.invitation_claimed','connection.paused','connection.resumed',
  'connection.revoked','consent.granted','consent.revoked','lab_import.received','lab_import.duplicate',
  'lab_import.accepted','lab_import.rejected','clinical_record.received','clinical_record.duplicate',
  'privacy_request.submitted','patient.created','lab_observation.reviewed','marker.view','document.viewed',
  'document.exported','report.exported','audit.exported','membership.role_changed','membership.suspended',
  'review_task.created','review_task.resolved','appointment.booked','appointment.rescheduled',
  'appointment.status_changed','appointment.corrected','encounter.started','encounter.completed',
  'encounter.cancelled','encounter.entered_in_error','note.draft_created','note.draft_saved',
  'note.ready_for_review','note.signed','note.addendum_created','note.entered_in_error',
  'protocol.draft_created','protocol.draft_saved','protocol.approved','protocol.activated',
  'protocol.paused','protocol.completed','protocol.discontinued','protocol.revision_created',
  'sync.export_queued','sync.resource_withdrawal_queued','sync.event_retried','sync.event_cancelled',
  'sync.inbound_accepted','sync.inbound_rejected','sync.inbound_correction_recorded','sync.conflict_resolved',
  'sync.provider_registered','sync.provider_reviewed','protocol.interaction_reviewed',
  'protocol_template.created','protocol_template.approved','protocol_template.archived'));

alter table clinical_audit.events drop constraint events_resource_type_check;
alter table clinical_audit.events add constraint events_resource_type_check check(resource_type in(
  'connection','consent','lab_import','clinical_record','privacy_request','patient_profile','lab_observation',
  'biomarker_observation','lab_document','report','audit_log','organization_membership','review_queue_item',
  'appointment','encounter','clinical_note','patient_protocol','patient_protocol_version',
  'sync_outbound_event','sync_inbound_event','sync_inbound_correction','sync_conflict','sync_provider',
  'protocol_item','protocol_template','protocol_template_version'));
