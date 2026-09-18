begin;

select plan(8);

select has_function('public', 'has_trusted_device', array[]::text[], 'remembered-device validation exists');
select has_function('public', 'get_current_trusted_devices', array[]::text[], 'remembered-device listing exists');
select volatility_is('public', 'has_trusted_device', array[]::text[], 'stable', 'remembered-device validation remains read-only');
select volatility_is('public', 'get_current_trusted_devices', array[]::text[], 'stable', 'remembered-device listing remains read-only');
select function_privs_are('public', 'has_trusted_device', array[]::text[], 'authenticated', array['EXECUTE'], 'authenticated employees may validate remembered devices');
select function_privs_are('public', 'get_current_trusted_devices', array[]::text[], 'authenticated', array['EXECUTE'], 'authenticated employees may list remembered devices');
select function_privs_are('public', 'has_trusted_device', array[]::text[], 'anon', array[]::text[], 'anonymous sessions cannot validate remembered devices');
select function_privs_are('public', 'get_current_trusted_devices', array[]::text[], 'anon', array[]::text[], 'anonymous sessions cannot list remembered devices');

select * from finish();

rollback;
