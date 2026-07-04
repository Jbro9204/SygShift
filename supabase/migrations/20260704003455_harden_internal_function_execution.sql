begin;

-- Event-trigger helpers are database infrastructure, not application RPC endpoints.
-- Keep the trigger function callable by the event trigger itself, but remove direct
-- execution paths from browser-facing roles.
revoke execute on function public.rls_auto_enable() from public, anon, authenticated;

commit;
