import { describe, expect, it } from "vitest";
import type { SygSphereCommsEvent } from "../../shared/sygsphere-communications/v1/contract";
import {
  createCommunicationsRuntimeState,
  parseSygSphereCommunicationsEvent,
  reduceCommunicationsRuntime,
} from "./sygsphereCommunicationsState";

const event = (
  kind: SygSphereCommsEvent["kind"],
  payload: Record<string, unknown>,
  sequence: number,
  roomId = "room-a",
): SygSphereCommsEvent => ({
  protocolVersion: 1,
  eventId: crypto.randomUUID(),
  roomId,
  roomEpoch: 1,
  roomSeq: sequence,
  serverTime: "2026-09-19T14:00:00.000Z",
  kind,
  payload,
});

describe("SygSphere communications runtime state", () => {
  it("ignores duplicate and stale room events", () => {
    const initial = createCommunicationsRuntimeState("employee-a");
    const first = reduceCommunicationsRuntime(initial, {
      type: "event.received",
      event: event("call.ringing", { callId: "call-a", invitationId: "invite-a" }, 3),
    });
    const stale = reduceCommunicationsRuntime(first, {
      type: "event.received",
      event: event("call.ended", { callId: "call-a" }, 2),
    });
    expect(stale).toBe(first);
    expect(stale.call?.status).toBe("ringing");
  });

  it("holds a release in progress until the protected cancellation is acknowledged", () => {
    let state = reduceCommunicationsRuntime(createCommunicationsRuntimeState("employee-a"), {
      type: "connection.ready",
      authorizationExpiresAt: "2026-09-19T14:01:00.000Z",
    });
    state = reduceCommunicationsRuntime(state, {
      type: "floor.requested",
      channelReference: "dispatch",
      requestId: "request-a",
    });
    state = reduceCommunicationsRuntime(state, { type: "floor.release.requested" });
    expect(state.floor).toMatchObject({ requestId: "request-a", status: "releasing" });
    state = reduceCommunicationsRuntime(state, {
      type: "event.received",
      event: event("floor.ready", {
        expiresAt: "2026-09-19T14:00:06.000Z",
        transmissionRequestId: "request-a",
      }, 1),
    });
    expect(state.floor).toMatchObject({ requestId: "request-a", status: "releasing" });
    state = reduceCommunicationsRuntime(state, { type: "floor.release.confirmed", requestId: "request-a" });
    expect(state.floor).toBeNull();
  });

  it("keeps PTT muted until both the floor grant and matching browser connection arrive", () => {
    let state = reduceCommunicationsRuntime(createCommunicationsRuntimeState("employee-a"), {
      type: "connection.ready",
      authorizationExpiresAt: "2026-09-19T14:01:00.000Z",
    });
    state = reduceCommunicationsRuntime(state, {
      type: "floor.requested",
      channelReference: "dispatch",
      requestId: "request-a",
    });
    state = reduceCommunicationsRuntime(state, {
      type: "event.received",
      event: event("floor.preparing", { transmissionRequestId: "request-a" }, 1, "ptt:request-a"),
    });
    state = reduceCommunicationsRuntime(state, {
      type: "event.received",
      event: event("floor.ready", { expiresAt: "2026-09-19T14:00:06.000Z", transmissionRequestId: "request-a" }, 2, "ptt:request-a"),
    });
    expect(state.floor).toMatchObject({ mediaConnected: false, status: "ready" });
    state = reduceCommunicationsRuntime(state, {
      type: "ptt.media.connected",
      requestId: "request-a",
      roomId: "ptt:request-a",
    });
    expect(state.floor).toMatchObject({ mediaConnected: true, status: "transmitting" });
  });

  it("ignores an old PTT terminal event while a newer floor is active", () => {
    let state = reduceCommunicationsRuntime(createCommunicationsRuntimeState("employee-a"), {
      type: "connection.ready",
      authorizationExpiresAt: "2026-09-19T14:01:00.000Z",
    });
    state = reduceCommunicationsRuntime(state, {
      type: "floor.requested",
      channelReference: "dispatch",
      requestId: "request-b",
    });
    const next = reduceCommunicationsRuntime(state, {
      type: "event.received",
      event: event("floor.revoked", { reason: "expired", transmissionRequestId: "request-a" }, 1, "ptt:request-a"),
    });
    expect(next.floor?.requestId).toBe("request-b");
    expect(next.lastError).toBeNull();
  });

  it("drops PTT state when a private call receives focus and waits for the browser media connection", () => {
    let state = reduceCommunicationsRuntime(createCommunicationsRuntimeState("employee-a"), {
      type: "connection.ready",
      authorizationExpiresAt: "2026-09-19T14:01:00.000Z",
    });
    state = reduceCommunicationsRuntime(state, {
      type: "floor.requested",
      channelReference: "site-a",
      requestId: "request-a",
    });
    state = reduceCommunicationsRuntime(state, {
      type: "event.received",
      event: event("call.ringing", { callId: "call-a", invitationId: "invite-a" }, 1),
    });
    state = reduceCommunicationsRuntime(state, {
      type: "event.received",
      event: event("call.accepted", { callId: "call-a" }, 2),
    });
    state = reduceCommunicationsRuntime(state, {
      type: "event.received",
      event: event("focus.granted", { callId: "call-a" }, 3),
    });
    expect(state.floor).toBeNull();
    expect(state.call?.status).toBe("connecting");
    state = reduceCommunicationsRuntime(state, {
      type: "event.received",
      event: event("media.negotiation", {
        callId: "call-a",
        descriptionType: "answer",
        direction: "publish",
        trackBindings: [{ publicationKind: "call_audio", role: "local" }],
      }, 4),
    });
    expect(state.call?.status).toBe("connecting");
    state = reduceCommunicationsRuntime(state, {
      type: "call.media.connected",
      callId: "call-a",
      roomId: "room-a",
    });
    expect(state.call?.status).toBe("active");
  });

  it("clears private state on revocation and account change", () => {
    let state = reduceCommunicationsRuntime(createCommunicationsRuntimeState("employee-a"), {
      type: "event.received",
      event: event("call.ringing", { callId: "call-a", invitationId: "invite-a" }, 1),
    });
    state = reduceCommunicationsRuntime(state, {
      type: "event.received",
      event: event("session.revoked", { reason: "Assignment ended." }, 2),
    });
    expect(state.connection).toBe("denied");
    expect(state.call).toBeNull();
    expect(state.roomVersions).toEqual({});

    state = reduceCommunicationsRuntime(state, { type: "account.changed", accountKey: "employee-b" });
    expect(state.accountKey).toBe("employee-b");
    expect(state.connection).toBe("unavailable");
  });

  it("clears a call when its control connection is lost", () => {
    let state = reduceCommunicationsRuntime(createCommunicationsRuntimeState("employee-a"), {
      type: "event.received",
      event: event("call.ringing", { callId: "call-a", invitationId: "invite-a" }, 1),
    });
    state = reduceCommunicationsRuntime(state, { type: "connection.lost", recoverable: true, reason: "offline" });
    expect(state.call).toBeNull();
    expect(state.connection).toBe("reconnecting");
  });

  it("fails closed when a provider media operation fails while keeping a healthy control session retryable", () => {
    let state = reduceCommunicationsRuntime(createCommunicationsRuntimeState("employee-a"), {
      type: "connection.ready",
      authorizationExpiresAt: "2026-09-19T14:01:00.000Z",
    });
    state = reduceCommunicationsRuntime(state, {
      type: "event.received",
      event: event("call.requested", { callId: "call-a" }, 1),
    });
    state = reduceCommunicationsRuntime(state, {
      type: "event.received",
      event: event("media.failed", { callId: "call-a", operation: "publish", retryAllowed: true }, 2),
    });

    expect(state.connection).toBe("ready");
    expect(state.call).toBeNull();
    expect(state.cameraActive).toBe(false);
    expect(state.screenActive).toBe(false);
    expect(state.lastError).toBe("Voice could not connect. Try again.");
  });

  it("shows call-media reconnecting state and ignores late camera or screen events from another call", () => {
    let state = reduceCommunicationsRuntime(createCommunicationsRuntimeState("employee-a"), {
      type: "event.received",
      event: event("call.requested", { callId: "call-a" }, 1),
    });
    state = reduceCommunicationsRuntime(state, {
      type: "call.media.connected",
      callId: "call-a",
      roomId: "room-a",
    });
    state = reduceCommunicationsRuntime(state, {
      type: "call.media.reconnecting",
      callId: "call-a",
      roomId: "room-a",
    });
    expect(state.call?.status).toBe("reconnecting");
    state = reduceCommunicationsRuntime(state, {
      type: "call.media.connected",
      callId: "call-a",
      roomId: "room-a",
    });
    expect(state.call?.status).toBe("active");

    const staleGrant = reduceCommunicationsRuntime(state, {
      type: "event.received",
      event: event("camera.granted", { callId: "call-b" }, 1, "room-b"),
    });
    expect(staleGrant.cameraActive).toBe(false);
    state = reduceCommunicationsRuntime(staleGrant, {
      type: "event.received",
      event: event("camera.granted", { callId: "call-a" }, 2),
    });
    expect(state.cameraActive).toBe(true);
    state = reduceCommunicationsRuntime(state, {
      type: "event.received",
      event: event("screen.granted", { callId: "call-b" }, 2, "room-b"),
    });
    expect(state.screenActive).toBe(false);
  });

  it("clears a matching expired media session without tearing down an unrelated call", () => {
    let state = reduceCommunicationsRuntime(createCommunicationsRuntimeState("employee-a"), {
      type: "event.received",
      event: event("call.requested", { callId: "call-a" }, 1),
    });
    const unrelated = reduceCommunicationsRuntime(state, {
      type: "event.received",
      event: event("media.closed", { callId: "call-b", generation: 1, reason: "expired" }, 1, "room-b"),
    });
    expect(unrelated.call?.callId).toBe("call-a");

    state = reduceCommunicationsRuntime(state, {
      type: "event.received",
      event: event("media.closed", { callId: "call-a", generation: 1, reason: "expired" }, 2),
    });
    expect(state.call).toBeNull();
    expect(state.lastError).toBe("The voice connection expired. Try again.");
  });

  it("rejects unknown event fields before state processing", () => {
    expect(() => parseSygSphereCommunicationsEvent({
      ...event("authenticated", {}, 1),
      tenantId: "browser-supplied",
    })).toThrow();
  });
});
