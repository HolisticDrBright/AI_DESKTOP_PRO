# Nutrition provider retirement integration

September 16, 2026. Original commercial phases 5 and 6, not a new phase.

Integrated Claude's 8caf96e retirement into the commercial-release-readiness branch
without removing newer lab/age/recovery work. Desktop no longer owns an outbound
Passio boundary or requires Passio production approval. Its provider-status route
honestly reports the external provider disabled, not a working Desktop USDA search.
Historical observation provenance is preserved.

V2's paired integration incorporates f7b6932 and repairs missing-nutrient coercion,
portion conversion, preparation-aware search, outbound lookup authorization and
runtime image packaging. Its committed public USDA catalog contains 6,020 records
and an archive/artifact digest manifest. Refer to V2 expo/docs/in-house-food-catalog.md.

Executed here: Desktop typecheck, lint (four existing warnings, no errors),
1,676 unit tests passing with 11 existing skips, and production-readiness refusal
tests. The removed vendor boundary accounts for fewer tests than the prior suite;
this does not mean fewer unresolved commercial requirements.

No cloud deployment, physical mobile acceptance, real patient-data activation or
paid mobile build occurred. Final-image verification is being added to the paired
V2 CI; do not infer it has passed until the exact-head run succeeds. Nutrition
storage continuity, production routing, diet-rule validation and physical meal-entry
acceptance remain part of the original engineering/qualification scope.
