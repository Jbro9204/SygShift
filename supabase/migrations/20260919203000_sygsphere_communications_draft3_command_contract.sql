begin;
set local lock_timeout = '5s';

-- Draft 3 adds bounded intents for call start, meetings, participant
-- moderation, and camera control. It never grants a permission or enables a
-- release gate; every target remains server-resolved from membership/scope.
alter table private.sygsphere_communications_release_gate
  drop constraint if exists sygsphere_communications_release_gate_version;
alter table private.sygsphere_communications_release_gate
  add constraint sygsphere_communications_release_gate_version
  check (contract_version in ('1.0.0-draft.2', '1.0.0-draft.3'));

alter table private.sygsphere_communications_command_ledger
  drop constraint if exists sygsphere_communications_command_ledger_kind;
alter table private.sygsphere_communications_command_ledger
  add constraint sygsphere_communications_command_ledger_kind check (command_kind in (
    'auth', 'heartbeat', 'resume', 'snapshot.request',
    'floor.request', 'floor.cancel', 'floor.renew', 'floor.release',
    'call.request', 'call.accept', 'call.decline', 'call.cancel', 'call.end',
    'meeting.create', 'meeting.join', 'meeting.leave', 'meeting.end',
    'participant.remove', 'participant.mute',
    'media.answer', 'media.ready', 'media.layout', 'media.stop',
    'camera.request', 'camera.release', 'screen.request', 'screen.release',
    'focus.request', 'focus.release'
  ));

create or replace function private.sygsphere_communications_required_permission(target_command_kind text)
returns text
language sql
immutable
security definer
set search_path = ''
as $$
  select case target_command_kind
    when 'floor.request' then 'sygsphere.comms.ptt.transmit'
    when 'floor.cancel' then 'sygsphere.comms.ptt.transmit'
    when 'floor.renew' then 'sygsphere.comms.ptt.transmit'
    when 'floor.release' then 'sygsphere.comms.ptt.transmit'
    when 'call.request' then 'sygsphere.comms.call.start'
    when 'call.accept' then 'sygsphere.comms.call.receive'
    when 'call.decline' then 'sygsphere.comms.call.receive'
    when 'call.cancel' then 'sygsphere.comms.call.start'
    when 'meeting.create' then 'sygsphere.comms.meeting.create'
    when 'meeting.end' then 'sygsphere.comms.moderate'
    when 'participant.remove' then 'sygsphere.comms.moderate'
    when 'participant.mute' then 'sygsphere.comms.moderate'
    when 'camera.request' then 'sygsphere.comms.video.publish'
    when 'screen.request' then 'sygsphere.comms.screen.publish'
    when 'auth' then 'sygsphere.comms.use'
    when 'heartbeat' then 'sygsphere.comms.use'
    when 'resume' then 'sygsphere.comms.use'
    when 'snapshot.request' then 'sygsphere.comms.use'
    when 'call.end' then 'sygsphere.comms.use'
    when 'meeting.join' then 'sygsphere.comms.use'
    when 'meeting.leave' then 'sygsphere.comms.use'
    when 'media.answer' then 'sygsphere.comms.use'
    when 'media.ready' then 'sygsphere.comms.use'
    when 'media.layout' then 'sygsphere.comms.use'
    when 'media.stop' then 'sygsphere.comms.use'
    when 'camera.release' then 'sygsphere.comms.use'
    when 'screen.release' then 'sygsphere.comms.use'
    when 'focus.request' then 'sygsphere.comms.use'
    when 'focus.release' then 'sygsphere.comms.use'
    else null
  end
$$;

-- Existing environments stay on draft 2 until both applications have
-- recorded matching draft-3 artifact digests in the controlled release gate.
notify pgrst, 'reload schema';
commit;
