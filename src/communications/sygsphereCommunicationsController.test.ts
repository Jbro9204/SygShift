import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SygSphereCommsEvent } from "../../shared/sygsphere-communications/v1/contract";
import { SygSphereCommunicationsController, type CommunicationsCoordinatorBridge, type CommunicationsCoordinatorSession } from "./sygsphereCommunicationsController";
import type { SygSphereCommunicationsMedia } from "./sygsphereCommunicationsMedia";

const event = (kind: SygSphereCommsEvent["kind"], payload: Record<string, unknown>, sequence: number): SygSphereCommsEvent => ({
  protocolVersion: 1,
  eventId: crypto.randomUUID(),
  roomId: "room-a",
  roomEpoch: 1,
  roomSeq: sequence,
  serverTime: "2026-09-19T14:00:00.000Z",
  kind,
  payload,
});

function harness() {
  let onEvent!: (value: SygSphereCommsEvent) => void;
  let onDisconnect!: (reason: string, recoverable: boolean) => void;
  let onRemoteTrack!: NonNullable<Parameters<CommunicationsCoordinatorBridge["connect"]>[0]["onRemoteTrack"]>;
  const session: CommunicationsCoordinatorSession = {
    close: vi.fn(),
    publish: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue(undefined),
    stopPublication: vi.fn().mockResolvedValue(undefined),
  };
  const bridge: CommunicationsCoordinatorBridge = {
    connect: vi.fn(async (input) => {
      onEvent = input.onEvent;
      onDisconnect = input.onDisconnect;
      onRemoteTrack = input.onRemoteTrack ?? (() => undefined);
      return {
        authorizationExpiresAt: "2026-09-19T14:01:00.000Z",
        connectionEpoch: 2,
        session,
      };
    }),
  };
  const microphone = {} as MediaStream;
  const screen = {} as MediaStream;
  const media = {
    acquireCamera: vi.fn().mockResolvedValue({} as MediaStream),
    acquireMicrophone: vi.fn().mockResolvedValue(microphone),
    acquireScreen: vi.fn().mockResolvedValue(screen),
    prepareMicrophone: vi.fn().mockResolvedValue(undefined),
    releaseAudioFocus: vi.fn(),
    setMicrophoneMuted: vi.fn().mockReturnValue(true),
    stopAll: vi.fn(),
    stopSource: vi.fn(),
  } as unknown as SygSphereCommunicationsMedia;
  const controller = new SygSphereCommunicationsController(bridge, media);
  return {
    bridge,
    controller,
    media,
    microphone,
    onDisconnect: () => onDisconnect,
    onEvent: () => onEvent,
    onRemoteTrack: () => onRemoteTrack,
    screen,
    session,
  };
}

describe("SygSphere communications controller", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("connects without requesting a browser device", async () => {
    const test = harness();
    await test.controller.start("employee-a");
    expect(test.controller.snapshot.connection).toBe("ready");
    expect(test.media.acquireMicrophone).not.toHaveBeenCalled();
    expect(test.media.acquireCamera).not.toHaveBeenCalled();
    expect(test.media.acquireScreen).not.toHaveBeenCalled();
  });

  it("prepares PTT while muted and enables it only after the matching ready grant", async () => {
    const test = harness();
    await test.controller.start("employee-a");
    await test.controller.holdToTalk("dispatch");
    const floorCommand = vi.mocked(test.session.send).mock.calls[0][0];
    expect(floorCommand.kind).toBe("floor.request");
    expect(test.session.publish).not.toHaveBeenCalled();
    await test.onEvent()(event("floor.preparing", {
      scope: "dispatch",
      transmissionRequestId: floorCommand.payload.clientIntentId,
    }, 1));
    expect(test.session.publish).toHaveBeenCalledWith(expect.objectContaining({
      channelReference: "dispatch",
      kind: "ptt",
      roomId: "room-a",
      stream: test.microphone,
      transmissionRequestId: floorCommand.payload.clientIntentId,
    }));
    expect(test.media.setMicrophoneMuted).not.toHaveBeenCalledWith(expect.anything(), false);
    await test.onEvent()(event("floor.ready", {
      expiresAt: new Date(Date.now() + 6_000).toISOString(),
      transmissionRequestId: floorCommand.payload.clientIntentId,
    }, 2));
    expect(test.media.setMicrophoneMuted).toHaveBeenCalledWith({
      kind: "ptt",
      sessionId: floorCommand.payload.clientIntentId,
    }, false);
  });

  it("does not publish a late PTT grant after release", async () => {
    const test = harness();
    await test.controller.start("employee-a");
    await test.controller.holdToTalk("dispatch");
    const requestId = vi.mocked(test.session.send).mock.calls[0][0].payload.clientIntentId;
    await test.controller.releaseToTalk();
    await test.onEvent()(event("floor.ready", {
      expiresAt: new Date(Date.now() + 6_000).toISOString(),
      transmissionRequestId: requestId,
    }, 1));
    expect(test.session.publish).not.toHaveBeenCalled();
    expect(test.media.releaseAudioFocus).toHaveBeenCalled();
  });

  it("treats a release during microphone preparation as an expected cancellation", async () => {
    const test = harness();
    let rejectMicrophone!: (reason?: unknown) => void;
    vi.mocked(test.media.acquireMicrophone).mockImplementationOnce(() => new Promise<MediaStream>((_resolve, reject) => {
      rejectMicrophone = reject;
    }));

    await test.controller.start("employee-a");
    const holding = test.controller.holdToTalk("dispatch");
    await Promise.resolve();
    await test.controller.releaseToTalk();
    rejectMicrophone(new DOMException("capture cancelled", "AbortError"));
    await holding;

    expect(test.controller.snapshot.floor).toBeNull();
    expect(test.controller.snapshot.lastError).toBeNull();
    expect(vi.mocked(test.session.send).mock.calls.some(([command]) => command.kind === "floor.cancel")).toBe(true);
  });

  it("returns PTT to idle immediately and remains idle when the server confirms release", async () => {
    const test = harness();
    await test.controller.start("employee-a");
    await test.controller.holdToTalk("dispatch");
    const requestId = vi.mocked(test.session.send).mock.calls[0][0].payload.clientIntentId;
    await test.onEvent()(event("floor.preparing", { transmissionRequestId: requestId }, 1));
    await test.onEvent()(event("floor.ready", {
      expiresAt: new Date(Date.now() + 6_000).toISOString(),
      transmissionRequestId: requestId,
    }, 2));

    await test.controller.releaseToTalk();
    expect(test.controller.snapshot.floor).toBeNull();
    expect(vi.mocked(test.session.send).mock.calls.some(([command]) => command.kind === "floor.release")).toBe(true);

    await test.onEvent()(event("transmission.ended", { reason: "ended", transmissionRequestId: requestId }, 3));
    expect(test.controller.snapshot.floor).toBeNull();
  });

  it("clears local PTT immediately and blocks overlapping floor requests", async () => {
    const test = harness();
    await test.controller.start("employee-a");
    await test.controller.holdToTalk("dispatch");
    await test.controller.holdToTalk("dispatch");
    expect(vi.mocked(test.session.send).mock.calls.filter(([command]) => command.kind === "floor.request")).toHaveLength(1);

    await test.controller.releaseToTalk();

    expect(test.controller.snapshot.floor).toBeNull();
    expect(test.media.releaseAudioFocus).toHaveBeenCalled();
    expect(vi.mocked(test.session.send).mock.calls.some(([command]) => command.kind === "floor.cancel")).toBe(true);
  });

  it("fails closed and stops capture when a media publication is rejected", async () => {
    const test = harness();
    vi.mocked(test.session.publish).mockRejectedValueOnce(new Error("Media provider unavailable."));
    await test.controller.start("employee-a");
    await test.controller.holdToTalk("dispatch");
    const requestId = vi.mocked(test.session.send).mock.calls[0][0].payload.clientIntentId;
    test.onEvent()(event("floor.preparing", {
      scope: "dispatch",
      transmissionRequestId: requestId,
    }, 1));

    await vi.waitFor(() => expect(test.controller.snapshot.floor).toBeNull());
    expect(test.media.stopAll).toHaveBeenCalled();
    expect(test.controller.snapshot.connection).toBe("ready");
    expect(test.controller.snapshot.lastError).toMatch(/Use messages or Dispatch/);
  });

  it("preserves an actionable timeout message when media preparation is slow", async () => {
    const test = harness();
    vi.mocked(test.session.publish).mockRejectedValueOnce(new Error("Communications media negotiation timed out."));
    await test.controller.start("employee-a");
    await test.controller.holdToTalk("dispatch");
    const requestId = vi.mocked(test.session.send).mock.calls[0][0].payload.clientIntentId;
    test.onEvent()(event("floor.preparing", {
      scope: "dispatch",
      transmissionRequestId: requestId,
    }, 1));

    await vi.waitFor(() => expect(test.controller.snapshot.floor).toBeNull());
    expect(test.controller.snapshot.lastError).toBe(
      "Voice setup took too long. Release the control and try again. Use messages or Dispatch while voice reconnects.",
    );
  });

  it("renews PTT every two seconds and accepts only the correlated authoritative lease", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-19T21:00:00.000Z"));
    try {
      const test = harness();
      await test.controller.start("employee-a");
      await test.controller.holdToTalk("dispatch");
      const requestId = vi.mocked(test.session.send).mock.calls[0][0].payload.clientIntentId;
      test.onEvent()(event("floor.preparing", {
        scope: "dispatch",
        transmissionRequestId: requestId,
      }, 1));
      await Promise.resolve();
      test.onEvent()(event("floor.ready", {
        expiresAt: "2026-09-19T21:00:06.000Z",
        transmissionRequestId: requestId,
      }, 2));
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(2_000);

      const renewal = vi.mocked(test.session.send).mock.calls.find(([command]) => command.kind === "floor.renew")?.[0];
      expect(renewal).toBeDefined();
      test.onEvent()(event("floor.renewed", {
        commandId: renewal?.commandId,
        generation: 1,
        leaseExpiresAt: "2026-09-19T21:00:08.000Z",
        transmissionRequestId: requestId,
      }, 3));
      await Promise.resolve();

      expect(test.controller.snapshot.floor).toMatchObject({
        leaseExpiresAt: "2026-09-19T21:00:08.000Z",
        leaseGeneration: 1,
        requestId,
      });
      expect(test.media.releaseAudioFocus).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops local PTT when the last acknowledged lease expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-19T21:00:00.000Z"));
    try {
      const test = harness();
      await test.controller.start("employee-a");
      await test.controller.holdToTalk("dispatch");
      const requestId = vi.mocked(test.session.send).mock.calls[0][0].payload.clientIntentId;
      test.onEvent()(event("floor.preparing", {
        scope: "dispatch",
        transmissionRequestId: requestId,
      }, 1));
      await Promise.resolve();
      test.onEvent()(event("floor.ready", {
        expiresAt: "2026-09-19T21:00:06.000Z",
        transmissionRequestId: requestId,
      }, 2));
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(6_000);

      expect(test.controller.snapshot.floor).toBeNull();
      expect(test.media.releaseAudioFocus).toHaveBeenCalledWith({ kind: "ptt", sessionId: requestId });
      expect(test.session.stopPublication).toHaveBeenCalledWith("ptt", "room-a");
      expect(test.controller.snapshot.lastError).toMatch(/not acknowledged/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the control connection ready when microphone permission is denied", async () => {
    const test = harness();
    vi.mocked(test.media.acquireMicrophone).mockRejectedValueOnce(new DOMException("denied", "NotAllowedError"));
    await test.controller.start("employee-a");
    await test.controller.holdToTalk("dispatch");
    expect(test.controller.snapshot.connection).toBe("ready");
    expect(test.controller.snapshot.floor).toBeNull();
    expect(test.controller.snapshot.lastError).toBe("Microphone or camera permission was not granted.");
  });

  it("preflights microphone permission on a normal click before PTT starts", async () => {
    const test = harness();
    await test.controller.start("employee-a");

    await expect(test.controller.preparePttMicrophone()).resolves.toBe(true);

    expect(test.media.prepareMicrophone).toHaveBeenCalledTimes(1);
    expect(test.session.send).not.toHaveBeenCalled();
    expect(test.controller.snapshot.floor).toBeNull();
  });

  it("coalesces repeated microphone setup requests into one browser probe", async () => {
    const test = harness();
    let resolvePreparation!: () => void;
    vi.mocked(test.media.prepareMicrophone).mockImplementationOnce(() => new Promise<void>((resolve) => {
      resolvePreparation = resolve;
    }));
    await test.controller.start("employee-a");

    const first = test.controller.preparePttMicrophone();
    const second = test.controller.preparePttMicrophone();
    expect(test.media.prepareMicrophone).toHaveBeenCalledTimes(1);
    resolvePreparation();

    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);
    expect(test.controller.snapshot.lastError).toBeNull();
  });

  it("shows the ordinary microphone permission guidance when PTT setup is declined", async () => {
    const test = harness();
    vi.mocked(test.media.prepareMicrophone).mockRejectedValueOnce(new DOMException("denied", "NotAllowedError"));
    await test.controller.start("employee-a");

    await expect(test.controller.preparePttMicrophone()).resolves.toBe(false);

    expect(test.controller.snapshot.connection).toBe("ready");
    expect(test.controller.snapshot.lastError).toBe("Microphone or camera permission was not granted.");
  });

  it("clears a prior setup error after a successful retry", async () => {
    const test = harness();
    vi.mocked(test.media.prepareMicrophone)
      .mockRejectedValueOnce(new DOMException("denied", "NotAllowedError"))
      .mockResolvedValueOnce(undefined);
    await test.controller.start("employee-a");

    await expect(test.controller.preparePttMicrophone()).resolves.toBe(false);
    expect(test.controller.snapshot.lastError).toBe("Microphone or camera permission was not granted.");
    await expect(test.controller.preparePttMicrophone()).resolves.toBe(true);
    expect(test.controller.snapshot.lastError).toBeNull();
  });

  it("does not let a late setup failure disrupt an incoming call", async () => {
    const test = harness();
    let rejectPreparation!: (reason?: unknown) => void;
    vi.mocked(test.media.prepareMicrophone).mockImplementationOnce(() => new Promise<void>((_resolve, reject) => {
      rejectPreparation = reject;
    }));
    const callId = "4896f7c0-7143-48f9-9978-d1f6a342186f";
    const invitationId = "d285bf11-15f6-4efe-b60f-4ab891637342";
    await test.controller.start("employee-a");

    const preparing = test.controller.preparePttMicrophone();
    await test.onEvent()(event("call.ringing", { callId, invitationId }, 1));
    rejectPreparation(new DOMException("denied", "NotAllowedError"));

    await expect(preparing).resolves.toBe(false);
    expect(test.controller.snapshot.call).toMatchObject({ callId, status: "ringing" });
    expect(test.controller.snapshot.lastError).toBeNull();
  });

  it("does not let a stale setup prompt block microphone setup after an account change", async () => {
    const test = harness();
    let resolveOldSetup!: () => void;
    vi.mocked(test.media.prepareMicrophone)
      .mockImplementationOnce(() => new Promise<void>((resolve) => {
        resolveOldSetup = resolve;
      }))
      .mockResolvedValueOnce(undefined);
    await test.controller.start("employee-a");

    const staleSetup = test.controller.preparePttMicrophone();
    await Promise.resolve();
    test.controller.stop("account_changed");
    await test.controller.start("employee-b");

    await expect(test.controller.preparePttMicrophone()).resolves.toBe(true);
    resolveOldSetup();
    await expect(staleSetup).resolves.toBe(false);
    expect(test.media.prepareMicrophone).toHaveBeenCalledTimes(2);
  });

  it("releases local PTT capture when the coordinator denies the floor", async () => {
    const test = harness();
    await test.controller.start("employee-a");
    await test.controller.holdToTalk("dispatch");
    await test.onEvent()(event("floor.denied", { reason: "busy" }, 1));
    expect(test.media.releaseAudioFocus).toHaveBeenCalled();
    expect(test.session.stopPublication).toHaveBeenCalledWith("ptt", "room-a");
  });

  it("publishes camera media only after the matching coordinator grant", async () => {
    const test = harness();
    await test.controller.start("employee-a");
    await test.onEvent()(event("call.ringing", { callId: "4896f7c0-7143-48f9-9978-d1f6a342186f", invitationId: "d285bf11-15f6-4efe-b60f-4ab891637342" }, 1));
    await test.controller.answerCall("4896f7c0-7143-48f9-9978-d1f6a342186f", "d285bf11-15f6-4efe-b60f-4ab891637342");
    await test.onEvent()(event("focus.granted", { callId: "4896f7c0-7143-48f9-9978-d1f6a342186f" }, 2));
    await test.controller.setCameraEnabled("4896f7c0-7143-48f9-9978-d1f6a342186f", true);
    expect(test.session.send).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "camera.request" }));
    expect(test.session.publish).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "camera" }));
    await test.onEvent()(event("camera.granted", { callId: "4896f7c0-7143-48f9-9978-d1f6a342186f" }, 3));
    expect(test.session.publish).toHaveBeenCalledWith(expect.objectContaining({ kind: "camera", roomId: "room-a" }));
  });

  it("applies call mute only to the active call microphone owner", async () => {
    const test = harness();
    const callId = "4896f7c0-7143-48f9-9978-d1f6a342186f";
    const invitationId = "d285bf11-15f6-4efe-b60f-4ab891637342";
    await test.controller.start("employee-a");
    await test.onEvent()(event("call.ringing", { callId, invitationId }, 1));
    await test.controller.answerCall(callId, invitationId);
    await test.onEvent()(event("focus.granted", { callId }, 2));

    expect(test.controller.setCallMicrophoneMuted(callId, true)).toBe(true);
    expect(test.media.setMicrophoneMuted).toHaveBeenCalledWith({ kind: "call", sessionId: callId }, true);
    expect(test.controller.setCallMicrophoneMuted("4896f7c0-7143-48f9-9978-d1f6a3421870", false)).toBe(false);
  });

  it("prepares the caller microphone after the call is accepted, not while it is still ringing", async () => {
    const test = harness();
    const callId = "4896f7c0-7143-48f9-9978-d1f6a342186f";
    await test.controller.start("employee-a");
    await test.controller.startCall("conversation-a");
    await test.onEvent()(event("call.requested", {
      callId,
      expiresAt: "2026-09-19T14:00:45.000Z",
      invitationId: "d285bf11-15f6-4efe-b60f-4ab891637342",
    }, 1));

    expect(test.media.acquireMicrophone).toHaveBeenCalledWith({ kind: "call", sessionId: callId });
    expect(test.session.publish).not.toHaveBeenCalled();
    await test.onEvent()(event("call.accepted", {
      callId,
      invitationId: "d285bf11-15f6-4efe-b60f-4ab891637342",
    }, 2));
    expect(test.session.publish).toHaveBeenCalledWith({ kind: "call_audio", roomId: "room-a", stream: test.microphone });
    expect(test.media.setMicrophoneMuted).toHaveBeenCalledWith({ kind: "call", sessionId: callId }, false);
  });

  it("automatically joins a meeting created by the current employee", async () => {
    const test = harness();
    const meetingId = "4896f7c0-7143-48f9-9978-d1f6a342186f";
    await test.controller.start("employee-a");
    await test.controller.createMeeting("conversation-a");
    await test.onEvent()(event("meeting.created", { meetingId }, 1));

    expect(test.media.acquireMicrophone).toHaveBeenCalledWith({ kind: "meeting", sessionId: meetingId });
    await vi.waitFor(() => expect(test.session.send).toHaveBeenLastCalledWith(expect.objectContaining({
      kind: "meeting.join",
      roomId: "room-a",
    })));
  });

  it("retains only authorized remote media for the active room and clears it on call end", async () => {
    const test = harness();
    const callId = "4896f7c0-7143-48f9-9978-d1f6a342186f";
    const remoteStream = {
      getTracks: () => [{ addEventListener: vi.fn() }],
    } as unknown as MediaStream;
    const observed = vi.fn();
    test.controller.subscribeRemoteMedia(observed);
    await test.controller.start("employee-a");
    await test.onEvent()(event("call.ringing", {
      callId,
      invitationId: "d285bf11-15f6-4efe-b60f-4ab891637342",
    }, 1));

    test.onRemoteTrack()({
      callId,
      mediaKind: "video",
      participantConnectionId: "8d2f99e1-0915-4517-88e0-c344ba284df8",
      publicationKind: "camera",
      roomId: "room-a",
      stream: remoteStream,
      trackReference: "remote-camera-a",
    });
    expect(test.controller.remoteMediaSnapshot).toHaveLength(1);
    test.onRemoteTrack()({
      callId,
      mediaKind: "video",
      participantConnectionId: null,
      publicationKind: "camera",
      roomId: "different-room",
      stream: remoteStream,
      trackReference: "wrong-room-camera",
    });
    expect(test.controller.remoteMediaSnapshot).toHaveLength(1);

    await test.onEvent()(event("call.ended", { callId, reason: "ended" }, 2));
    expect(test.controller.remoteMediaSnapshot).toHaveLength(0);
    expect(observed).toHaveBeenLastCalledWith([]);
  });

  it("uses bounded draft-4 intents for direct calls, meetings, and moderation", async () => {
    const test = harness();
    await test.controller.start("employee-a");
    await test.controller.startCall("conversation-a");
    await test.controller.createMeeting("conversation-a");
    await test.controller.joinMeeting("4896f7c0-7143-48f9-9978-d1f6a342186f");
    await test.controller.moderateParticipant(
      "4896f7c0-7143-48f9-9978-d1f6a342186f",
      "d285bf11-15f6-4efe-b60f-4ab891637342",
      "mute",
    );
    expect(vi.mocked(test.session.send).mock.calls.map(([command]) => command.kind)).toEqual([
      "call.request",
      "meeting.create",
      "meeting.join",
      "participant.mute",
    ]);
    expect(test.media.acquireMicrophone).toHaveBeenCalledWith({
      kind: "meeting",
      sessionId: "4896f7c0-7143-48f9-9978-d1f6a342186f",
    });
  });

  it("stops meeting microphone, camera, screen, and publications before leaving", async () => {
    const test = harness();
    const meetingId = "4896f7c0-7143-48f9-9978-d1f6a342186f";
    await test.controller.start("employee-a");
    await test.controller.joinMeeting(meetingId);
    await test.onEvent()(event("meeting.joined", { meetingId, participantConnectionId: "d285bf11-15f6-4efe-b60f-4ab891637342" }, 1));
    await test.controller.leaveMeeting(meetingId);

    expect(test.media.releaseAudioFocus).toHaveBeenCalledWith({ kind: "meeting", sessionId: meetingId });
    expect(test.media.stopSource).toHaveBeenCalledWith("camera");
    expect(test.media.stopSource).toHaveBeenCalledWith("screen");
    expect(test.session.stopPublication).toHaveBeenCalledWith("call_audio", "room-a");
    expect(test.session.stopPublication).toHaveBeenCalledWith("camera", "room-a");
    expect(test.session.stopPublication).toHaveBeenCalledWith("screen", "room-a");
    expect(test.session.send).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "meeting.leave", roomId: "room-a" }));
  });

  it("stops every local source on coordinator disconnect", async () => {
    const test = harness();
    await test.controller.start("employee-a");
    test.onDisconnect()("authorization_expired", false);
    expect(test.media.stopAll).toHaveBeenCalled();
    expect(test.controller.snapshot.connection).toBe("failed");
  });

  it("uses a fresh protected connection after bounded recoverable loss", async () => {
    vi.useFakeTimers();
    try {
      let disconnect!: (reason: string, recoverable: boolean) => void;
      const first = { close: vi.fn() } as unknown as CommunicationsCoordinatorSession;
      const second = { close: vi.fn() } as unknown as CommunicationsCoordinatorSession;
      const bridge: CommunicationsCoordinatorBridge = {
        connect: vi.fn(async (input) => {
          disconnect = input.onDisconnect;
          return {
            authorizationExpiresAt: null,
            connectionEpoch: vi.mocked(bridge.connect).mock.calls.length,
            session: vi.mocked(bridge.connect).mock.calls.length === 1 ? first : second,
          };
        }),
      };
      const media = { stopAll: vi.fn() } as unknown as SygSphereCommunicationsMedia;
      const controller = new SygSphereCommunicationsController(bridge, media);
      await controller.start("employee-a");
      disconnect("temporary network loss", true);
      expect(controller.snapshot.connection).toBe("reconnecting");
      expect(media.stopAll).toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(500);
      expect(bridge.connect).toHaveBeenCalledTimes(2);
      expect(controller.snapshot.connection).toBe("ready");
      expect(controller.snapshot.connectionEpoch).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels a pending reconnect when the employee session ends", async () => {
    vi.useFakeTimers();
    try {
      let disconnect!: (reason: string, recoverable: boolean) => void;
      const bridge: CommunicationsCoordinatorBridge = {
        connect: vi.fn(async (input) => {
          disconnect = input.onDisconnect;
          return {
            authorizationExpiresAt: null,
            connectionEpoch: 1,
            session: { close: vi.fn() } as unknown as CommunicationsCoordinatorSession,
          };
        }),
      };
      const controller = new SygSphereCommunicationsController(
        bridge,
        { stopAll: vi.fn() } as unknown as SygSphereCommunicationsMedia,
      );
      await controller.start("employee-a");
      disconnect("temporary network loss", true);
      controller.stop("logout");
      await vi.advanceTimersByTimeAsync(30_000);
      expect(bridge.connect).toHaveBeenCalledTimes(1);
      expect(controller.snapshot.accountKey).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes a late connection after the account session ended", async () => {
    let resolve!: (value: Awaited<ReturnType<CommunicationsCoordinatorBridge["connect"]>>) => void;
    const session = { close: vi.fn() } as unknown as CommunicationsCoordinatorSession;
    const bridge: CommunicationsCoordinatorBridge = {
      connect: vi.fn(() => new Promise<Awaited<ReturnType<CommunicationsCoordinatorBridge["connect"]>>>((next) => { resolve = next; })),
    };
    const media = { stopAll: vi.fn() } as unknown as SygSphereCommunicationsMedia;
    const controller = new SygSphereCommunicationsController(bridge, media);
    const pending = controller.start("employee-a");
    controller.stop();
    resolve({ authorizationExpiresAt: "2026-09-19T14:01:00.000Z", connectionEpoch: 1, session });
    await pending;
    expect(session.close).toHaveBeenCalledWith("stale_connection");
    expect(controller.snapshot.accountKey).toBeNull();
  });
});
