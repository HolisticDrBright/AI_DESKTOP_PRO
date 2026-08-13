-- Phase 9E-B: extend clinical_knowledge_import_items.entity_type CHECK to
-- accept the three new entity types the Research Handoff pipeline uses:
--   product_label_research      — one row per Product Research Handoff record
--   product_label_evidence      — one row per evidence source (URL-only, unarchived)
--   product_label_commercial_link — one row per commercial link (commercial_only=true)

alter table public.clinical_knowledge_import_items
  drop constraint if exists clinical_knowledge_import_items_entity_type_check;
alter table public.clinical_knowledge_import_items
  add constraint clinical_knowledge_import_items_entity_type_check
  check (entity_type = any (array[
    'pathway','product_label','catalog_product','knowledge_reference','knowledge_claim',
    'lab_suggestion','interpretation_rule','intervention_class','protocol_template','graph_edge',
    'product_label_research','product_label_evidence','product_label_commercial_link'
  ]));
