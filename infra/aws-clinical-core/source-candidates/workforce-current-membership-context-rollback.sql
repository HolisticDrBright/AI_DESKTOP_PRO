-- Rollback for workforce-current-membership-context.sql (UNREGISTERED; applied nowhere). The candidate
-- (SHA-256 ff89c1a2d5b934a3a49437099d14b34e5dffed400ae332f26eea2c311a891342) only creates this one function and
-- grants it to clinical_core_api. Dropping it removes the grant with it and touches no table, row, policy or other
-- function. It fails if the function is absent, so a rollback cannot be mistaken for one that did nothing.
--
-- Afterwards every `database_current` workforce request refuses with 503: the setter is missing and the handler never
-- falls back to token claims. The legacy claim path (set_request_context) is unaffected.

drop function clinical_private.set_current_workforce_context(text,uuid,text);
