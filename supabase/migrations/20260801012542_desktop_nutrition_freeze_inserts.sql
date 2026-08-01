-- Phase 9A: close the insert seam in the version freeze.
--
-- The content-protect triggers fired on UPDATE and DELETE, which stops a
-- frozen version being EDITED but not a frozen version being ADDED TO. A
-- published template could still gain a food rule, and an approved plan could
-- still gain a meal — and "the approved plan grew a new instruction after
-- approval" is exactly the failure this phase exists to make impossible.
--
-- Safe to extend to INSERT because every writer creates content while the
-- owning version is still a draft: `write_nutrition_content` refuses a
-- non-draft owner, `copy_nutrition_content` always targets a freshly created
-- draft, and the starter installer writes content before it publishes.

begin;

drop trigger if exists nutrition_phases_content_protect on public.nutrition_phases;
create trigger nutrition_phases_content_protect
  before insert or update or delete on public.nutrition_phases
  for each row execute function private.nutrition_content_protect();

drop trigger if exists nutrition_food_rules_content_protect on public.nutrition_food_rules;
create trigger nutrition_food_rules_content_protect
  before insert or update or delete on public.nutrition_food_rules
  for each row execute function private.nutrition_content_protect();

drop trigger if exists nutrition_meal_days_content_protect on public.nutrition_meal_days;
create trigger nutrition_meal_days_content_protect
  before insert or update or delete on public.nutrition_meal_days
  for each row execute function private.nutrition_content_protect();

drop trigger if exists nutrition_recipes_content_protect on public.nutrition_recipes;
create trigger nutrition_recipes_content_protect
  before insert or update or delete on public.nutrition_recipes
  for each row execute function private.nutrition_content_protect();

drop trigger if exists nutrition_grocery_content_protect on public.nutrition_grocery_items;
create trigger nutrition_grocery_content_protect
  before insert or update or delete on public.nutrition_grocery_items
  for each row execute function private.nutrition_content_protect();

drop trigger if exists nutrition_meals_content_protect on public.nutrition_meals;
create trigger nutrition_meals_content_protect
  before insert or update or delete on public.nutrition_meals
  for each row execute function private.nutrition_meal_content_protect();

drop trigger if exists nutrition_meal_items_content_protect on public.nutrition_meal_items;
create trigger nutrition_meal_items_content_protect
  before insert or update or delete on public.nutrition_meal_items
  for each row execute function private.nutrition_meal_content_protect();

/**
 * An amendment is the sanctioned way to add to an approved plan, and it lands
 * BESIDE the version rather than inside it. Constraints and safety flags,
 * however, describe the assessment behind a version, so once that version is
 * frozen they are frozen too — a constraint quietly added after approval would
 * rewrite the record of what was known at the time.
 */
create or replace function private.nutrition_assessment_protect()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare _frozen boolean;
begin
  select status in ('approved','active','paused','completed','discontinued','superseded')
    into _frozen from public.nutrition_plan_versions
   where id = coalesce(new.plan_version_id, old.plan_version_id);

  if coalesce(_frozen, false) then
    raise exception 'the assessment behind a frozen version cannot be changed'
      using errcode = '42501';
  end if;
  return coalesce(new, old);
end;
$$;

create trigger nutrition_constraints_protect
  before insert or update or delete on public.nutrition_constraints
  for each row execute function private.nutrition_assessment_protect();

revoke all on function private.nutrition_assessment_protect()
  from public, anon, authenticated;

commit;
