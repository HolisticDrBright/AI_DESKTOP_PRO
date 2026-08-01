-- Phase 9A: make the freeze triggers operation-explicit.
--
-- The content guards were written for UPDATE and DELETE, where both NEW and
-- OLD exist, and read whichever was populated via `coalesce`. Now that they
-- also fire on INSERT — where OLD is not assigned — that shortcut is wrong.
-- Branch on TG_OP instead, which is what the guards actually meant.

begin;

create or replace function private.nutrition_content_protect()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare _frozen boolean := false; _pv uuid; _tv uuid;
begin
  if tg_op = 'DELETE' then
    _pv := old.plan_version_id; _tv := old.template_version_id;
  else
    _pv := new.plan_version_id; _tv := new.template_version_id;
  end if;

  if _pv is not null then
    select status in ('approved','active','paused','completed','discontinued','superseded')
      into _frozen from public.nutrition_plan_versions where id = _pv;
  elsif _tv is not null then
    select status in ('published','superseded','archived')
      into _frozen from public.nutrition_template_versions where id = _tv;
  end if;

  if coalesce(_frozen, false) then
    raise exception 'the content of a frozen version cannot be changed'
      using errcode = '42501';
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create or replace function private.nutrition_meal_content_protect()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare _day uuid; _frozen boolean;
begin
  if tg_op = 'DELETE' then
    if tg_table_name = 'nutrition_meals' then
      _day := old.meal_day_id;
    else
      select m.meal_day_id into _day from public.nutrition_meals m where m.id = old.meal_id;
    end if;
  else
    if tg_table_name = 'nutrition_meals' then
      _day := new.meal_day_id;
    else
      select m.meal_day_id into _day from public.nutrition_meals m where m.id = new.meal_id;
    end if;
  end if;

  select coalesce(
    (select pv.status in ('approved','active','paused','completed','discontinued','superseded')
       from public.nutrition_plan_versions pv where pv.id = d.plan_version_id),
    (select tv.status in ('published','superseded','archived')
       from public.nutrition_template_versions tv where tv.id = d.template_version_id)
  ) into _frozen
  from public.nutrition_meal_days d where d.id = _day;

  if coalesce(_frozen, false) then
    raise exception 'the content of a frozen version cannot be changed'
      using errcode = '42501';
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create or replace function private.nutrition_assessment_protect()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare _frozen boolean; _pv uuid;
begin
  _pv := case when tg_op = 'DELETE' then old.plan_version_id else new.plan_version_id end;

  select status in ('approved','active','paused','completed','discontinued','superseded')
    into _frozen from public.nutrition_plan_versions where id = _pv;

  if coalesce(_frozen, false) then
    raise exception 'the assessment behind a frozen version cannot be changed'
      using errcode = '42501';
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

commit;
