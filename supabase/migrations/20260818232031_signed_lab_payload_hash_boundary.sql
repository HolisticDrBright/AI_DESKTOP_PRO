-- Keep the sender's lab payload hash stable across the JSONB round trip.
-- The application hashes deterministic JSON with recursively sorted keys.
-- PostgreSQL validates that same representation before the legacy ingress
-- performs its structural, consent, provider, and idempotency checks.
begin;

create or replace function private.sync_canonical_json(_value jsonb)
returns text language sql immutable security definer set search_path = ''
as $$
  select case jsonb_typeof(_value)
    when 'object' then (
      select '{' || coalesce(string_agg(
        to_jsonb(key)::text || ':' || private.sync_canonical_json(value),
        ',' order by key collate "C"
      ), '') || '}'
      from jsonb_each(_value)
    )
    when 'array' then (
      select '[' || coalesce(string_agg(
        private.sync_canonical_json(value),
        ',' order by ordinal
      ), '') || ']'
      from jsonb_array_elements(_value) with ordinality as items(value, ordinal)
    )
    else _value::text
  end;
$$;

alter function public.record_sync_lab_result(
  uuid,text,text,text,jsonb,text,timestamptz,text,text,text,uuid
) rename to record_sync_lab_result_pgtext;

revoke all on function public.record_sync_lab_result_pgtext(
  uuid,text,text,text,jsonb,text,timestamptz,text,text,text,uuid
) from public, anon, authenticated, service_role;

create or replace function public.record_sync_lab_result(
  _connection_id uuid, _provider_event_id text, _contract_version text,
  _resource_type text, _payload jsonb, _payload_hash text,
  _occurred_at timestamptz, _external_resource_id text default null,
  _resource_version text default null, _signature_key_id text default null,
  _correlation_id uuid default null
) returns jsonb language plpgsql security definer set search_path = ''
as $$
begin
  if _payload is null
     or jsonb_typeof(_payload) <> 'object'
     or coalesce(_payload_hash, '') !~ '^[0-9a-f]{64}$'
     or private.sha256_hex(private.sync_canonical_json(_payload)) is distinct from _payload_hash then
    raise exception 'invalid lab result payload or hash' using errcode = '22023';
  end if;

  return public.record_sync_lab_result_pgtext(
    _connection_id,
    _provider_event_id,
    _contract_version,
    _resource_type,
    _payload,
    private.sha256_hex(_payload::text),
    _occurred_at,
    _external_resource_id,
    _resource_version,
    _signature_key_id,
    _correlation_id
  );
end;
$$;

revoke all on function private.sync_canonical_json(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.record_sync_lab_result(
  uuid,text,text,text,jsonb,text,timestamptz,text,text,text,uuid
) from public, anon, authenticated;
grant execute on function public.record_sync_lab_result(
  uuid,text,text,text,jsonb,text,timestamptz,text,text,text,uuid
) to service_role;

commit;
