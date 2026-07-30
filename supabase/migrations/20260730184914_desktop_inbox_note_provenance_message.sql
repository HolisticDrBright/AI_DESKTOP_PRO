-- desktop_inbox_note_provenance_message
--
-- Messages are now a first-class provenance source for clinical notes
-- (Phase 4 inbox: append_message_to_note records exactly which message a
-- quoted passage came from). Widen the ref_type registry; nothing existing
-- changes.

begin;

alter table public.note_provenance_refs
  drop constraint if exists note_provenance_refs_ref_type_check;
alter table public.note_provenance_refs
  add constraint note_provenance_refs_ref_type_check
  check (ref_type in ('appointment','encounter','lab_observation','lab_document',
                      'patient_form','chart_item','practitioner_entered',
                      'transcript','differential_question','lens_evaluation','message'));

commit;
