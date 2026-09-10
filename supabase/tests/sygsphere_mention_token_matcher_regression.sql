-- Run after 20260912050000_repair_sygsphere_mention_token_matcher.sql.
-- The test is read-only and is wrapped for consistency with production contract tests.
begin;
set local statement_timeout = '30s';

do $$
begin
  assert private.sygsphere_body_has_mention('Hello @Michelle', 'Michelle');
  assert private.sygsphere_body_has_mention('Hello @mIcHeLle!', 'Michelle');
  assert private.sygsphere_body_has_mention('Hello @Michelle.', 'Michelle');
  assert private.sygsphere_body_has_mention('Please review with @Michelle Hood.', 'Michelle Hood');
  assert private.sygsphere_body_has_mention('Please ask @Anne O''Neil (HR).', 'Anne O''Neil');
  assert private.sygsphere_body_has_mention('Please ask @A+B [Ops]!', 'A+B [Ops]');
  assert not private.sygsphere_body_has_mention('mail@Michelle', 'Michelle');
  assert not private.sygsphere_body_has_mention('Hello @Michelle.Hood', 'Michelle');
  assert not private.sygsphere_body_has_mention('Hello everyone', '');
  assert not has_function_privilege('authenticated', 'private.sygsphere_body_has_mention(text,text)', 'EXECUTE');
  assert not has_function_privilege('anon', 'private.sygsphere_body_has_mention(text,text)', 'EXECUTE');
end
$$;

rollback;
