-- Cover the auth-user foreign key used by account/session cleanup without
-- changing the existing employee/expiry heartbeat lookup path.

create index if not exists platform_presence_auth_user_idx
on private.platform_presence_sessions(auth_user_id);
