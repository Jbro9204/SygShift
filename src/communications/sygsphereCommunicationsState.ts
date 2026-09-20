import {
  parseSygSphereCommsEvent as parseSharedSygSphereCommsEvent,
  SYGSPHERE_COMMS_PROTOCOL_VERSION,
  type SygSphereCommsEvent,
} from "../../shared/sygsphere-communications/v1/contract";

export type CommunicationsConnectionState =
  | "unavailable"
  | "authorizing"
  | "connecting"
  | "ready"
  | "reconnecting"
  | "denied"
  | "failed";

export type CommunicationsFloorState = Readonly<{
  channelReference: string;
  leaseExpiresAt: string | null;
  leaseGeneration: number | null;
  requestId: string;
  roomId: string | null;
  status: "requesting" | "preparing" | "ready" | "transmitting" | "releasing";
}>;

export type CommunicationsCallState = Readonly<{
  callId: string;
  invitationId: string | null;
  kind: "direct" | "meeting";
  roomId: string;
  status: "ringing" | "connecting" | "reconnecting" | "active";
}>;

export type CommunicationsRuntimeState = Readonly<{
  accountKey: string | null;
  authorizationExpiresAt: string | null;
  cameraActive: boolean;
  call: CommunicationsCallState | null;
  connection: CommunicationsConnectionState;
  connectionEpoch: number;
  floor: CommunicationsFloorState | null;
  lastError: string | null;
  microphoneMutedByModerator: boolean;
  roomVersions: Readonly<Record<string, Readonly<{ epoch: number; sequence: number }>>>;
  screenActive: boolean;
  sessionGeneration: number;
}>;

export type CommunicationsRuntimeAction =
  | Readonly<{ type: "account.changed"; accountKey: string | null }>
  | Readonly<{ type: "authorization.started" }>
  | Readonly<{ type: "connection.started"; connectionEpoch: number }>
  | Readonly<{ type: "connection.ready"; authorizationExpiresAt: string | null }>
  | Readonly<{ type: "connection.lost"; recoverable: boolean; reason?: string }>
  | Readonly<{ type: "authorization.lost"; reason?: string }>
  | Readonly<{ type: "floor.requested"; channelReference: string; requestId: string }>
  | Readonly<{ type: "floor.release.requested" }>
  | Readonly<{ type: "floor.failed"; reason: string }>
  | Readonly<{ type: "ptt.microphone.prepared" }>
  | Readonly<{ type: "ptt.microphone.failed"; reason: string }>
  | Readonly<{ type: "call.media.connected"; callId: string; roomId: string }>
  | Readonly<{ type: "call.media.reconnecting"; callId: string; roomId: string }>
  | Readonly<{ type: "call.local.ended"; callId: string }>
  | Readonly<{ type: "meeting.dismissed"; meetingId: string }>
  | Readonly<{ type: "local.media.failed"; reason: string }>
  | Readonly<{ type: "event.received"; event: SygSphereCommsEvent }>
  | Readonly<{ type: "session.ended" }>;

export function parseSygSphereCommunicationsEvent(input: unknown): SygSphereCommsEvent {
  return parseSharedSygSphereCommsEvent(input);
}

export function createCommunicationsRuntimeState(accountKey: string | null = null): CommunicationsRuntimeState {
  return resetState(normalizeAccountKey(accountKey), 0, "unavailable");
}

export function reduceCommunicationsRuntime(
  state: CommunicationsRuntimeState,
  action: CommunicationsRuntimeAction,
): CommunicationsRuntimeState {
  switch (action.type) {
    case "account.changed": {
      const accountKey = normalizeAccountKey(action.accountKey);
      if (accountKey === state.accountKey) return state;
      return resetState(accountKey, state.sessionGeneration + 1, "unavailable");
    }
    case "authorization.started":
      return { ...state, connection: "authorizing", lastError: null };
    case "connection.started":
      return {
        ...state,
        authorizationExpiresAt: null,
        connection: state.connection === "reconnecting" ? "reconnecting" : "connecting",
        connectionEpoch: action.connectionEpoch,
        lastError: null,
      };
    case "connection.ready":
      return {
        ...state,
        authorizationExpiresAt: action.authorizationExpiresAt,
        connection: "ready",
        lastError: null,
      };
    case "connection.lost":
      return {
        ...state,
        authorizationExpiresAt: null,
        call: null,
        connection: action.recoverable ? "reconnecting" : "failed",
        floor: null,
        screenActive: false,
        lastError: action.reason ?? null,
        sessionGeneration: state.sessionGeneration + 1,
      };
    case "authorization.lost":
      return {
        ...resetState(state.accountKey, state.sessionGeneration + 1, "denied"),
        lastError: action.reason ?? null,
      };
    case "floor.requested":
      if (state.connection !== "ready" || state.call) return state;
      return {
        ...state,
        floor: {
          channelReference: action.channelReference,
          leaseExpiresAt: null,
          leaseGeneration: null,
          requestId: action.requestId,
          roomId: null,
          status: "requesting",
        },
        lastError: null,
      };
    case "floor.release.requested":
      return state.floor ? { ...state, floor: null } : state;
    case "floor.failed":
      return { ...state, floor: null, lastError: action.reason };
    // A microphone setup probe is intentionally independent of calls, camera,
    // and screen media. Never use the broader local.media.failed transition
    // here: a browser permission result may arrive after a call invitation.
    case "ptt.microphone.prepared":
      return { ...state, lastError: null };
    case "ptt.microphone.failed":
      return { ...state, lastError: action.reason };
    case "call.media.connected":
      return state.call?.callId === action.callId && state.call.roomId === action.roomId
        ? { ...state, call: { ...state.call, status: "active" }, lastError: null }
        : state;
    case "call.media.reconnecting":
      return state.call?.callId === action.callId && state.call.roomId === action.roomId
        ? { ...state, call: { ...state.call, status: "reconnecting" } }
        : state;
    case "call.local.ended":
      return state.call?.callId === action.callId
        ? clearCallState(state, null)
        : state;
    case "meeting.dismissed":
      return state.call?.kind === "meeting" && state.call.callId === action.meetingId && state.call.status === "ringing"
        ? { ...state, call: null }
        : state;
    case "local.media.failed":
      return {
        ...state,
        call: null,
        cameraActive: false,
        floor: null,
        lastError: action.reason,
        screenActive: false,
      };
    case "event.received":
      return reduceServerEvent(state, action.event);
    case "session.ended":
      return resetState(null, state.sessionGeneration + 1, "unavailable");
  }
  return state;
}

function reduceServerEvent(
  state: CommunicationsRuntimeState,
  event: SygSphereCommsEvent,
): CommunicationsRuntimeState {
  if (event.protocolVersion !== SYGSPHERE_COMMS_PROTOCOL_VERSION) return state;
  const currentVersion = state.roomVersions[event.roomId];
  if (currentVersion && (
    event.roomEpoch < currentVersion.epoch
    || (event.roomEpoch === currentVersion.epoch && event.roomSeq <= currentVersion.sequence)
  )) return state;

  const next = {
    ...state,
    roomVersions: {
      ...state.roomVersions,
      [event.roomId]: { epoch: event.roomEpoch, sequence: event.roomSeq },
    },
  };
  const payload = event.payload as Record<string, unknown>;

  switch (event.kind) {
    case "authenticated":
      return { ...next, connection: "ready", lastError: null };
    case "authorization.expiring":
      return { ...next, connection: "reconnecting" };
    case "session.revoked":
      return {
        ...resetState(state.accountKey, state.sessionGeneration + 1, "denied"),
        lastError: stringValue(payload.reason),
      };
    case "floor.preparing": {
      if (!state.floor || state.floor.status === "releasing") return next;
      const requestId = stringValue(payload.transmissionRequestId) ?? state.floor.requestId;
      if (requestId !== state.floor.requestId) return next;
      return { ...next, floor: { ...state.floor, roomId: event.roomId, status: "preparing" } };
    }
    case "floor.ready": {
      if (!state.floor || state.floor.status === "releasing") return next;
      const requestId = stringValue(payload.transmissionRequestId) ?? state.floor.requestId;
      if (requestId !== state.floor.requestId) return next;
      return {
        ...next,
        floor: {
          ...state.floor,
          leaseExpiresAt: stringValue(payload.expiresAt),
          roomId: event.roomId,
          status: "ready",
        },
      };
    }
    case "floor.renewed": {
      if (!state.floor || stringValue(payload.transmissionRequestId) !== state.floor.requestId) return next;
      const generation = numberValue(payload.generation);
      const leaseExpiresAt = stringValue(payload.leaseExpiresAt);
      if (generation === null || leaseExpiresAt === null) return next;
      if (state.floor.leaseGeneration !== null && generation <= state.floor.leaseGeneration) return next;
      return { ...next, floor: { ...state.floor, leaseExpiresAt, leaseGeneration: generation } };
    }
    case "transmission.started":
      return state.floor?.roomId === event.roomId && state.floor.status !== "releasing"
        ? { ...next, floor: { ...state.floor, status: "transmitting" } }
        : next;
    case "floor.denied":
    case "floor.revoked":
    case "transmission.ended":
      return { ...next, floor: null, lastError: stringValue(payload.reason) };
    case "call.ringing": {
      const callId = stringValue(payload.callId);
      if (!callId) return next;
      return {
        ...next,
        call: {
          callId,
          invitationId: stringValue(payload.invitationId),
          kind: "direct",
          roomId: event.roomId,
          status: "ringing",
        },
        lastError: null,
        microphoneMutedByModerator: false,
      };
    }
    case "call.requested": {
      const callId = stringValue(payload.callId);
      if (!callId) return next;
      return {
        ...next,
        call: { callId, invitationId: null, kind: "direct", roomId: event.roomId, status: "connecting" },
        floor: null,
        lastError: null,
        microphoneMutedByModerator: false,
      };
    }
    case "call.accepted": {
      const callId = stringValue(payload.callId) ?? state.call?.callId;
      if (!callId) return next;
      return {
        ...next,
        call: {
          callId,
          invitationId: state.call?.invitationId ?? stringValue(payload.invitationId),
          kind: state.call?.kind ?? "direct",
          roomId: event.roomId,
          status: "connecting",
        },
        floor: null,
        lastError: null,
        microphoneMutedByModerator: false,
      };
    }
    case "media.negotiation":
      // An SDP answer advances negotiation, but it is not yet a live audio
      // path. The browser promotes this call only after its peer connection
      // reaches `connected`.
      return next;
    case "participant.changed":
    case "participant.removed":
    case "media.policy":
    case "media.source.available":
    case "media.source.unavailable":
      return next;
    case "participant.muted":
      return payload.self === true && state.call?.kind === "meeting" && state.call.roomId === event.roomId
        ? { ...next, microphoneMutedByModerator: true, lastError: "A meeting moderator muted your microphone." }
        : next;
    case "meeting.created":
    case "meeting.joined": {
      const meetingId = stringValue(payload.meetingId);
      if (!meetingId) return next;
      const invited = event.kind === "meeting.created" && payload.invited === true;
      return {
        ...next,
        call: {
          callId: meetingId,
          invitationId: null,
          kind: "meeting",
          roomId: event.roomId,
          // Joining a meeting only begins its media attempt. Keep the
          // workspace visibly connecting until its audio negotiation has
          // completed successfully.
          status: invited ? "ringing" : "connecting",
        },
        floor: null,
        lastError: null,
        microphoneMutedByModerator: false,
      };
    }
    case "focus.granted":
      return isCurrentCallEvent(state, event, stringValue(payload.callId))
        ? { ...next, floor: null }
        : next;
    case "call.ended":
    case "call.missed":
    case "meeting.ended": {
      const callId = stringValue(payload.callId) ?? stringValue(payload.meetingId);
      return isCurrentCallEvent(state, event, callId)
        ? clearCallState(next, terminalCallMessage(stringValue(payload.reason)))
        : next;
    }
    case "media.failed":
      return clearMatchingMediaState(
        state,
        next,
        event,
        stringValue(payload.callId),
        payload.retryAllowed === true
          ? "Voice could not connect. Try again."
          : "Voice service is temporarily unavailable. Try again in a moment.",
      );
    case "media.closed":
      return clearMatchingMediaState(
        state,
        next,
        event,
        stringValue(payload.callId),
        terminalCallMessage(stringValue(payload.reason)),
      );
    case "camera.granted":
      return isCurrentCallEvent(state, event, stringValue(payload.callId))
        ? { ...next, cameraActive: true }
        : next;
    case "camera.denied":
    case "camera.revoked":
      return isCurrentCallEvent(state, event, stringValue(payload.callId))
        ? { ...next, cameraActive: false, lastError: stringValue(payload.reason) }
        : next;
    case "screen.granted":
      return isCurrentCallEvent(state, event, stringValue(payload.callId))
        ? { ...next, screenActive: true }
        : next;
    case "screen.denied":
    case "screen.revoked":
      return isCurrentCallEvent(state, event, stringValue(payload.callId))
        ? { ...next, screenActive: false, lastError: stringValue(payload.reason) }
        : next;
    case "focus.denied":
    case "focus.revoked":
      return isCurrentCallEvent(state, event, stringValue(payload.callId))
        ? clearCallState(next, terminalCallMessage(stringValue(payload.reason)) ?? "Voice access is no longer available. Try again.")
        : next;
    case "snapshot":
      return next;
  }
  return next;
}

function isCurrentCallEvent(
  state: CommunicationsRuntimeState,
  event: SygSphereCommsEvent,
  callId: string | null,
): boolean {
  return state.call?.roomId === event.roomId && state.call.callId === callId;
}

function clearMatchingMediaState(
  state: CommunicationsRuntimeState,
  next: CommunicationsRuntimeState,
  event: SygSphereCommsEvent,
  callId: string | null,
  message: string | null,
): CommunicationsRuntimeState {
  const clearsCall = isCurrentCallEvent(state, event, callId);
  const clearsFloor = state.floor?.roomId === event.roomId
    && (state.floor.requestId === callId || !state.call);
  if (!clearsCall && !clearsFloor) return next;
  return {
    ...next,
    ...(clearsCall ? {
      call: null,
      cameraActive: false,
      microphoneMutedByModerator: false,
      screenActive: false,
    } : {}),
    ...(clearsFloor ? { floor: null } : {}),
    lastError: message,
  };
}

function clearCallState(state: CommunicationsRuntimeState, message: string | null): CommunicationsRuntimeState {
  return {
    ...state,
    call: null,
    cameraActive: false,
    floor: null,
    lastError: message,
    microphoneMutedByModerator: false,
    screenActive: false,
  };
}

function terminalCallMessage(reason: string | null): string | null {
  switch (reason) {
    case "expired":
      return "The voice connection expired. Try again.";
    case "unavailable":
      return "Voice service is temporarily unavailable. Try again in a moment.";
    case "network_lost":
      return "The voice connection was lost. Try again.";
    case "authorization_changed":
      return "Voice access changed. Reopen Communications and try again.";
    case "moderated":
      return "You were removed from this voice session.";
    default:
      return null;
  }
}

function resetState(
  accountKey: string | null,
  sessionGeneration: number,
  connection: CommunicationsConnectionState,
): CommunicationsRuntimeState {
  return {
    accountKey,
    authorizationExpiresAt: null,
    cameraActive: false,
    call: null,
    connection,
    connectionEpoch: 0,
    floor: null,
    lastError: null,
    microphoneMutedByModerator: false,
    roomVersions: {},
    screenActive: false,
    sessionGeneration,
  };
}

function normalizeAccountKey(value: string | null): string | null {
  const normalized = value?.trim() ?? "";
  return normalized.length > 0 ? normalized : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
