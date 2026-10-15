-- Rollback for program-step-purchase-priced.sql (BLOCKED; applied nowhere). Restores program-step-purchase.sql's
-- check to the API role and removes only what the priced candidate created. No price, offer, enrollment or step row
-- is touched: the candidate wrote none.
grant execute on function clinical_core.program_step_purchase_check(jsonb) to clinical_core_api;
drop function clinical_core.program_step_purchase_priced_check(jsonb);
drop function clinical_private.program_step_price_configured(uuid,uuid);
drop trigger program_step_purchase_priced_activation_append_only on clinical_core.program_step_purchase_priced_activation;
drop table clinical_core.program_step_purchase_priced_activation;
