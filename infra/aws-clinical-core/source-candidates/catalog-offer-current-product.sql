-- Candidate forward catalog read guard. Not registered/applied by this file.
-- The two-entry reference ledger is pinned by the active routing rehearsal;
-- that history must not be rewritten or silently expanded by a source repair.
-- No source contents, approvals or historical versions are changed. An old
-- approved offer is not authority to order a product whose CURRENT approved
-- version is no longer eligible for direct order. This preserves separately
-- approved owner destinations without adding a label gate or granting approval.
drop policy affiliate_offer_versions_read_active on commercial_reference.affiliate_offer_versions;
create policy affiliate_offer_versions_read_active on commercial_reference.affiliate_offer_versions
for select to clinical_core_api
using (
  direct_order_allowed = true and declared_restricted = false
  and environment = nullif(current_setting('clinical.catalog.environment', true), '')
  and exists (
    select 1 from commercial_reference.affiliate_offers o
    where o.stable_id = affiliate_offer_versions.offer_stable_id
      and o.review_status = 'approved' and o.active_version = affiliate_offer_versions.version
  )
  and exists (
    select 1 from clinical_reference.catalog_products p
    join clinical_reference.catalog_product_versions v
      on v.product_stable_id = p.stable_id and v.version = p.active_version
    where p.stable_id = affiliate_offer_versions.product_stable_id
      and p.review_status = 'approved' and p.contains_phi = false
      and p.environment = affiliate_offer_versions.environment
      and p.environment = nullif(current_setting('clinical.catalog.environment', true), '')
      and v.product_type = 'supplement' and v.access_tier = 'open'
      and v.declared_restricted = false and v.direct_order_allowed = true
  )
);
