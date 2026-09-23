import { describe, expect, it, vi } from "vitest";
import {
  SygSphereCommunicationsSocketBridge,
  type SygSphereCommunicationsPeerTransportAdapter,
  type SygSphereCommunicationsPeerTransportFactory,
} from "./sygsphereCommunicationsSocketBridge";

const expiresAt = "2026-09-19T21:00:30.000Z";
const ticket = "a".repeat(43);

describe("SygSphere communications protected socket bridge", () => {
  it("keeps the ticket out of the URL and sends it only in the first application frame", async () => {
    const socket = new FakeSocket();
    const bootstrap = vi.fn(async () => validBootstrap(ticket));
    const bridge = createBridge({ bootstrap, socket });
    const connected = bridge.connect({ accountKey: "employee-session", onDisconnect: vi.fn(), onEvent: vi.fn() });

    await socketCreated(socket);
    expect(socket.url).toBe("wss://sygilant.us/api/comms/v1/connect");
    expect(socket.url).not.toContain(ticket);
    expect(socket.protocols).toEqual(["sygsphere-comms-route.11111111-1111-4111-8111-111111111111.22222222-2222-4222-8222-222222222222"]);
    socket.open();
    expect(socket.sent).toEqual([JSON.stringify({ kind: "auth", protocolVersion: 1, ticket })]);
    socket.message(JSON.stringify({ kind: "authenticated", protocolVersion: 1 }));

    const result = await connected;
    expect(result.authorizationExpiresAt).toBeNull();
    expect(result.connectionEpoch).toBe(1);
    expect(bootstrap).toHaveBeenCalledTimes(1);
  });

  it("requires a fresh protected bootstrap for every new connection", async () => {
    const first = new FakeSocket();
    const second = new FakeSocket();
    const sockets = [first, second];
    const bootstrap = vi.fn()
      .mockResolvedValueOnce(validBootstrap("a".repeat(43)))
      .mockResolvedValueOnce(validBootstrap("b".repeat(43)));
    const bridge = createBridge({ bootstrap, sockets });

    const one = bridge.connect({ accountKey: "employee-session", onDisconnect: vi.fn(), onEvent: vi.fn() });
    await socketCreated(first);
    first.open();
    first.message(JSON.stringify({ kind: "authenticated", protocolVersion: 1 }));
    (await one).session.close("test");

    const two = bridge.connect({ accountKey: "employee-session", onDisconnect: vi.fn(), onEvent: vi.fn() });
    await socketCreated(second);
    second.open();
    second.message(JSON.stringify({ kind: "authenticated", protocolVersion: 1 }));
    expect((await two).connectionEpoch).toBe(2);
    expect(bootstrap).toHaveBeenCalledTimes(2);
    expect(second.sent[0]).toContain("b".repeat(43));
    expect(second.sent[0]).not.toContain("a".repeat(43));
  });

  it("rejects expired, malformed, and unauthenticated handshakes", async () => {
    const expired = createBridge({
      bootstrap: vi.fn(async () => ({ ...validBootstrap(ticket), connection: { ...validBootstrap(ticket).connection, expiresAt: "2026-09-19T20:59:59.000Z" } })),
      socket: new FakeSocket(),
    });
    await expect(expired.connect({ accountKey: "employee-session", onDisconnect: vi.fn(), onEvent: vi.fn() }))
      .rejects.toThrow("expired");

    const malformedSocket = new FakeSocket();
    const malformed = createBridge({
      bootstrap: vi.fn(async () => ({ ...validBootstrap(ticket), connection: { ...validBootstrap(ticket).connection, socketPath: "https://attacker.example/socket" } })),
      socket: malformedSocket,
    });
    await expect(malformed.connect({ accountKey: "employee-session", onDisconnect: vi.fn(), onEvent: vi.fn() }))
      .rejects.toThrow();

    const rejectedSocket = new FakeSocket();
    const rejected = createBridge({ bootstrap: vi.fn(async () => validBootstrap(ticket)), socket: rejectedSocket });
    const connection = rejected.connect({ accountKey: "employee-session", onDisconnect: vi.fn(), onEvent: vi.fn() });
    await socketCreated(rejectedSocket);
    rejectedSocket.open();
    rejectedSocket.message(JSON.stringify({ kind: "command.outcome", outcome: "unavailable", protocolVersion: 1 }));
    await expect(connection).rejects.toThrow("verify");
    expect(rejectedSocket.closedWith?.code).toBe(4501);
  });

  it("closes malformed authenticated frames with a browser-valid protocol code", async () => {
    const socket = new FakeSocket();
    const bridge = createBridge({ bootstrap: vi.fn(async () => validBootstrap(ticket)), socket });
    const connection = bridge.connect({ accountKey: "employee-session", onDisconnect: vi.fn(), onEvent: vi.fn() });
    await socketCreated(socket);
    socket.open();
    socket.message(JSON.stringify({ kind: "authenticated", protocolVersion: 1 }));
    await connection;

    socket.message("not json");

    expect(socket.closedWith).toEqual({ code: 4400, reason: "Communications connection unavailable." });
  });

  it("validates outbound commands, sends mutations through the protected HTTP boundary, and forwards only canonical server events", async () => {
    const socket = new FakeSocket();
    const onEvent = vi.fn();
    const sendCommand = vi.fn(async () => acceptedCommand());
    const bridge = createBridge({ bootstrap: vi.fn(async () => validBootstrap(ticket)), sendCommand, socket });
    const connection = bridge.connect({ accountKey: "employee-session", onDisconnect: vi.fn(), onEvent });
    await socketCreated(socket);
    socket.open();
    socket.message(JSON.stringify({ kind: "authenticated", protocolVersion: 1 }));
    const { session } = await connection;

    await session.send({
      commandId: "8c225928-3f6a-46ca-b90b-5bd86765f451",
      connectionEpoch: 999,
      kind: "floor.request",
      payload: {
        channelReference: "dispatch",
        clientIntentId: "c1571265-0cf4-49a1-89f0-a94956babfaa",
      },
      protocolVersion: 1,
    });
    expect(sendCommand).toHaveBeenCalledWith(
      "access-token",
      expect.objectContaining({ connectionEpoch: 1, kind: "floor.request" }),
      expect.any(AbortSignal),
    );
    expect(socket.sent.map((item) => JSON.parse(item))).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "floor.request" }),
    ]));

    socket.message(JSON.stringify({
      eventId: "8d2f99e1-0915-4517-88e0-c344ba284df8",
      kind: "call.ringing",
      payload: {
        callId: "4896f7c0-7143-48f9-9978-d1f6a342186f",
        expiresAt: "2026-09-19T21:00:31.000Z",
        invitationId: "d285bf11-15f6-4efe-b60f-4ab891637342",
      },
      protocolVersion: 1,
      roomEpoch: 1,
      roomId: "room-1",
      roomSeq: 1,
      serverTime: "2026-09-19T21:00:01.000Z",
    }));
    await vi.waitFor(() => expect(onEvent).toHaveBeenCalledTimes(1));
  });

  it("routes strict media negotiation through the peer transport before forwarding the event", async () => {
    const socket = new FakeSocket();
    const onEvent = vi.fn();
    const peerTransport = createFakePeerTransport();
    const bridge = createBridge({
      bootstrap: vi.fn(async () => validBootstrap(ticket)),
      peerTransport: peerTransport.adapter,
      socket,
    });
    const connection = bridge.connect({ accountKey: "employee-session", onDisconnect: vi.fn(), onEvent });
    await socketCreated(socket);
    socket.open();
    socket.message(JSON.stringify({ kind: "authenticated", protocolVersion: 1 }));
    await connection;

    socket.message(JSON.stringify({
      eventId: "8d2f99e1-0915-4517-88e0-c344ba284df8",
      kind: "media.negotiation",
      payload: {
        callId: "4896f7c0-7143-48f9-9978-d1f6a342186f",
        description: "v=0\r\n",
        descriptionType: "offer",
        direction: "subscribe",
        expiresAt: "2026-09-19T21:00:31.000Z",
        generation: 1,
        iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }],
        negotiationId: "d285bf11-15f6-4efe-b60f-4ab891637342",
        peerHandle: "peer-1",
        trackBindings: [{
          mediaKind: "audio",
          participantConnectionId: "58f2be04-75dc-4cb9-a7da-7c3d6daa20b4",
          publicationKind: "call_audio",
          role: "remote",
          trackReference: "track-1",
          transceiverMid: "0",
        }],
      },
      protocolVersion: 1,
      roomEpoch: 1,
      roomId: "room-1",
      roomSeq: 1,
      serverTime: "2026-09-19T21:00:01.000Z",
    }));

    await vi.waitFor(() => expect(peerTransport.handleNegotiation).toHaveBeenCalledTimes(1));
    expect(peerTransport.handleNegotiation).toHaveBeenCalledWith("room-1", expect.objectContaining({
      generation: 1,
      peerHandle: "peer-1",
    }));
    await vi.waitFor(() => expect(onEvent).toHaveBeenCalledTimes(1));
  });

  it("acknowledges a PTT listener only after its browser media connection is live", async () => {
    const socket = new FakeSocket();
    const acknowledgePttListenerReady = vi.fn(async () => acceptedCommand());
    const preparePtt = vi.fn(async () => ({
      iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }],
      requestId: "d285bf11-15f6-4efe-b60f-4ab891637342",
    }));
    const sendCommand = vi.fn(async () => acceptedCommand());
    const startPtt = vi.fn(async () => acceptedCommand());
    const peer = createFakeRtcPeer("connecting");
    const bridge = createBridge({
      acknowledgePttListenerReady,
      bootstrap: vi.fn(async () => validBootstrap(ticket)),
      createRtcPeer: () => peer,
      preparePtt,
      sendCommand,
      socket,
      startPtt,
    });
    const connection = bridge.connect({ accountKey: "employee-session", onDisconnect: vi.fn(), onEvent: vi.fn() });
    await socketCreated(socket);
    socket.open();
    socket.message(JSON.stringify({ kind: "authenticated", protocolVersion: 1 }));
    await connection;

    socket.message(JSON.stringify({
      eventId: "8d2f99e1-0915-4517-88e0-c344ba284df8",
      kind: "transmission.started",
      payload: {
        scope: "dispatch",
        transmissionRequestId: "4896f7c0-7143-48f9-9978-d1f6a342186f",
      },
      protocolVersion: 1,
      roomEpoch: 1,
      roomId: "ptt:4896f7c0-7143-48f9-9978-d1f6a342186f",
      roomSeq: 1,
      serverTime: "2026-09-19T21:00:01.000Z",
    }));
    await vi.waitFor(() => expect(startPtt).toHaveBeenCalledWith(
      "access-token",
      expect.objectContaining({ mode: "listener", transmissionRequestId: "4896f7c0-7143-48f9-9978-d1f6a342186f" }),
      expect.any(AbortSignal),
    ));
    expect((startPtt.mock.calls as unknown as Array<[string, Record<string, unknown>]>)[0]?.[1]).not.toHaveProperty("offer");
    expect(acknowledgePttListenerReady).not.toHaveBeenCalled();

    socket.message(JSON.stringify({
      eventId: "73f004e3-34e3-48b2-9bca-7be78c4f04a6",
      kind: "media.negotiation",
      payload: {
        callId: "4896f7c0-7143-48f9-9978-d1f6a342186f",
        description: "v=0\r\n",
        descriptionType: "offer",
        direction: "subscribe",
        expiresAt: "2026-09-19T21:00:31.000Z",
        generation: 1,
        iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }],
        negotiationId: "d285bf11-15f6-4efe-b60f-5bd86765f451",
        peerHandle: "peer-listener",
        trackBindings: [{
          mediaKind: "audio",
          participantConnectionId: "58f2be04-75dc-4cb9-a7da-7c3d6daa20b4",
          publicationKind: "ptt",
          role: "remote",
          trackReference: "track-1",
          transceiverMid: "0",
        }],
      },
      protocolVersion: 1,
      roomEpoch: 1,
      roomId: "ptt:4896f7c0-7143-48f9-9978-d1f6a342186f",
      roomSeq: 2,
      serverTime: "2026-09-19T21:00:02.000Z",
    }));
    await vi.waitFor(() => expect(peer.setRemoteDescription).toHaveBeenCalledWith({ sdp: "v=0\r\n", type: "offer" }));
    await vi.waitFor(() => expect(peer.createAnswer).toHaveBeenCalledTimes(1));
    expect(peer.createOffer).not.toHaveBeenCalled();
    expect(peer.addTransceiver).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(sendCommand).toHaveBeenCalledWith(
      "access-token",
      expect.objectContaining({
        kind: "media.answer",
        payload: expect.objectContaining({
          answer: "v=0\r\n",
          generation: 1,
          negotiationId: "d285bf11-15f6-4efe-b60f-5bd86765f451",
          peerHandle: "peer-listener",
        }),
        roomId: "ptt:4896f7c0-7143-48f9-9978-d1f6a342186f",
      }),
      expect.any(AbortSignal),
    ));
    expect(acknowledgePttListenerReady).not.toHaveBeenCalled();
    peer.setConnectionState("connected");
    await vi.waitFor(() => expect(acknowledgePttListenerReady).toHaveBeenCalledWith(
      "access-token",
      { transmissionRequestId: "4896f7c0-7143-48f9-9978-d1f6a342186f" },
      expect.any(AbortSignal),
    ));
  });

  it("cleans a failed PTT listener without acknowledging it or dropping the control socket", async () => {
    const socket = new FakeSocket();
    const transmissionRequestId = "4896f7c0-7143-48f9-9978-d1f6a342186f";
    const acknowledgePttListenerReady = vi.fn(async () => acceptedCommand());
    const reportPttListenerFailure = vi.fn(async () => acceptedCommand());
    const startPtt = vi.fn(async () => acceptedCommand());
    const peer = createFakeRtcPeer("connecting");
    const bridge = createBridge({
      acknowledgePttListenerReady,
      bootstrap: vi.fn(async () => validBootstrap(ticket)),
      createRtcPeer: () => peer,
      reportPttListenerFailure,
      socket,
      startPtt,
    });
    const connection = bridge.connect({ accountKey: "employee-session", onDisconnect: vi.fn(), onEvent: vi.fn() });
    await socketCreated(socket);
    socket.open();
    socket.message(JSON.stringify({ kind: "authenticated", protocolVersion: 1 }));
    await connection;

    startPttListener(socket, transmissionRequestId);
    await vi.waitFor(() => expect(startPtt).toHaveBeenCalledTimes(1));
    offerPttListener(socket, transmissionRequestId);
    await vi.waitFor(() => expect(peer.setRemoteDescription).toHaveBeenCalledTimes(1));
    peer.setConnectionState("failed");

    await vi.waitFor(() => expect(peer.close).toHaveBeenCalledTimes(1));
    expect(acknowledgePttListenerReady).not.toHaveBeenCalled();
    expect(reportPttListenerFailure).toHaveBeenCalledWith(
      "access-token",
      { transmissionRequestId },
      expect.any(AbortSignal),
    );
    expect(socket.closedWith).toBeNull();
  });

  it("ignores a delayed PTT provider offer after the floor is revoked", async () => {
    const socket = new FakeSocket();
    const transmissionRequestId = "4896f7c0-7143-48f9-9978-d1f6a342186f";
    const peer = createFakeRtcPeer("connecting");
    const peerTransport = createFakePeerTransport();
    const sendCommand = vi.fn(async () => acceptedCommand());
    const bridge = createBridge({
      bootstrap: vi.fn(async () => validBootstrap(ticket)),
      createPeerTransport: peerTransport.factory,
      createRtcPeer: () => peer,
      sendCommand,
      socket,
    });
    const connection = bridge.connect({ accountKey: "employee-session", onDisconnect: vi.fn(), onEvent: vi.fn() });
    await socketCreated(socket);
    socket.open();
    socket.message(JSON.stringify({ kind: "authenticated", protocolVersion: 1 }));
    await connection;

    startPttListener(socket, transmissionRequestId);
    await vi.waitFor(() => expect(peer.createOffer).not.toHaveBeenCalled());
    socket.message(JSON.stringify({
      eventId: "be15ea6d-e3e1-42f1-b376-e12943a361b6",
      kind: "floor.revoked",
      payload: { reason: "expired", transmissionRequestId },
      protocolVersion: 1,
      roomEpoch: 1,
      roomId: `ptt:${transmissionRequestId}`,
      roomSeq: 2,
      serverTime: "2026-09-19T21:00:02.000Z",
    }));
    await vi.waitFor(() => expect(peer.close).toHaveBeenCalledTimes(1));
    offerPttListener(socket, transmissionRequestId);
    await Promise.resolve();

    expect(peer.setRemoteDescription).not.toHaveBeenCalled();
    expect(sendCommand).not.toHaveBeenCalled();
    expect(peerTransport.handleNegotiation).not.toHaveBeenCalled();
  });

  it("cancels an in-flight PTT publisher before it can send stale audio", async () => {
    const socket = new FakeSocket();
    const transmissionRequestId = "4896f7c0-7143-48f9-9978-d1f6a342186f";
    let resolvePreparation!: (value: unknown) => void;
    const preparePtt = vi.fn(() => new Promise<unknown>((resolve) => { resolvePreparation = resolve; }));
    const startPtt = vi.fn(async () => acceptedCommand());
    const peer = createFakeRtcPeer("connecting");
    const bridge = createBridge({
      bootstrap: vi.fn(async () => validBootstrap(ticket)),
      createRtcPeer: () => peer,
      preparePtt,
      socket,
      startPtt,
    });
    const connection = bridge.connect({ accountKey: "employee-session", onDisconnect: vi.fn(), onEvent: vi.fn() });
    await socketCreated(socket);
    socket.open();
    socket.message(JSON.stringify({ kind: "authenticated", protocolVersion: 1 }));
    const { session } = await connection;

    const publish = session.publish({
      channelReference: "dispatch",
      kind: "ptt",
      roomId: `ptt:${transmissionRequestId}`,
      stream: { getAudioTracks: () => [{} as MediaStreamTrack] } as unknown as MediaStream,
      transmissionRequestId,
    });
    await vi.waitFor(() => expect(preparePtt).toHaveBeenCalledTimes(1));
    await session.stopPublication("ptt", `ptt:${transmissionRequestId}`);
    resolvePreparation({
      iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }],
      requestId: "d285bf11-15f6-4efe-b60f-5bd86765f451",
    });
    await publish;

    expect(peer.createOffer).not.toHaveBeenCalled();
    expect(startPtt).not.toHaveBeenCalled();
  });

  it("does not create a duplicate PTT listener while the first listener is still preparing", async () => {
    const socket = new FakeSocket();
    const transmissionRequestId = "4896f7c0-7143-48f9-9978-d1f6a342186f";
    const peer = createFakeRtcPeer("connecting");
    let resolveStart!: (value: unknown) => void;
    const startPtt = vi.fn(() => new Promise<unknown>((resolve) => { resolveStart = resolve; }));
    const bridge = createBridge({
      bootstrap: vi.fn(async () => validBootstrap(ticket)),
      createRtcPeer: () => peer,
      socket,
      startPtt,
    });
    const connection = bridge.connect({ accountKey: "employee-session", onDisconnect: vi.fn(), onEvent: vi.fn() });
    await socketCreated(socket);
    socket.open();
    socket.message(JSON.stringify({ kind: "authenticated", protocolVersion: 1 }));
    const { session } = await connection;

    startPttListener(socket, transmissionRequestId);
    await vi.waitFor(() => expect(startPtt).toHaveBeenCalledTimes(1));
    startPttListener(socket, transmissionRequestId);
    await Promise.resolve();
    expect(startPtt).toHaveBeenCalledTimes(1);
    expect(peer.createOffer).not.toHaveBeenCalled();

    resolveStart(acceptedCommand());
    session.close("test_complete");
    await vi.waitFor(() => expect(peer.close).toHaveBeenCalledTimes(1));
  });

  it("cleans a listener that is disposed before the provider offer arrives", async () => {
    const socket = new FakeSocket();
    const transmissionRequestId = "4896f7c0-7143-48f9-9978-d1f6a342186f";
    const peer = createFakeRtcPeer("connecting");
    const startPtt = vi.fn(async () => acceptedCommand());
    const bridge = createBridge({
      bootstrap: vi.fn(async () => validBootstrap(ticket)),
      createRtcPeer: () => peer,
      socket,
      startPtt,
    });
    const connection = bridge.connect({ accountKey: "employee-session", onDisconnect: vi.fn(), onEvent: vi.fn() });
    await socketCreated(socket);
    socket.open();
    socket.message(JSON.stringify({ kind: "authenticated", protocolVersion: 1 }));
    const { session } = await connection;

    startPttListener(socket, transmissionRequestId);
    await vi.waitFor(() => expect(startPtt).toHaveBeenCalledTimes(1));
    session.close("test_complete");

    await vi.waitFor(() => expect(peer.close).toHaveBeenCalledTimes(1));
  });

  it("negotiates a meeting audio publication through the protected provider boundary", async () => {
    const socket = new FakeSocket();
    const meetingId = "4896f7c0-7143-48f9-9978-d1f6a342186f";
    const prepareMeetingMedia = vi.fn(async () => ({
      iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }],
      requestId: "d285bf11-15f6-4efe-b60f-5bd86765f451",
    }));
    const startMeetingMedia = vi.fn(async () => acceptedCommand());
    const peer = createFakeRtcPeer();
    const bridge = createBridge({
      bootstrap: vi.fn(async () => validBootstrap(ticket)),
      createRtcPeer: () => peer,
      prepareMeetingMedia,
      socket,
      startMeetingMedia,
    });
    const connection = bridge.connect({ accountKey: "employee-session", onDisconnect: vi.fn(), onEvent: vi.fn() });
    await socketCreated(socket);
    socket.open();
    socket.message(JSON.stringify({ kind: "authenticated", protocolVersion: 1 }));
    const { session } = await connection;
    const audioTrack = {} as MediaStreamTrack;
    await session.publish({
      kind: "call_audio",
      roomId: `meeting:${meetingId}`,
      stream: { getAudioTracks: () => [audioTrack], getVideoTracks: () => [] } as unknown as MediaStream,
    });
    expect(prepareMeetingMedia).toHaveBeenCalledWith(
      "access-token",
      meetingId,
      { mediaKind: "audio" },
      expect.any(AbortSignal),
    );
    expect(startMeetingMedia).toHaveBeenCalledWith(
      "access-token",
      meetingId,
      "publish",
      expect.objectContaining({ mediaKind: "audio", offer: "v=0\r\n", transceiverMid: "0" }),
      expect.any(AbortSignal),
    );

    socket.message(JSON.stringify({
      eventId: "73f004e3-34e3-48b2-9bca-7be78c4f04a6",
      kind: "media.negotiation",
      payload: {
        callId: meetingId,
        description: "v=0\r\n",
        descriptionType: "answer",
        direction: "publish",
        expiresAt: "2026-09-19T21:00:31.000Z",
        generation: 1,
        iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }],
        negotiationId: "d285bf11-15f6-4efe-b60f-5bd86765f451",
        peerHandle: "peer-publisher",
        trackBindings: [{
          mediaKind: "audio",
          publicationKind: "call_audio",
          role: "local",
          trackReference: "meeting-audio",
          transceiverMid: "0",
        }],
      },
      protocolVersion: 1,
      roomEpoch: 1,
      roomId: `meeting:${meetingId}`,
      roomSeq: 1,
      serverTime: "2026-09-19T21:00:02.000Z",
    }));
    await vi.waitFor(() => expect(peer.setRemoteDescription).toHaveBeenCalledWith({ sdp: "v=0\r\n", type: "answer" }));
  });

  it("re-arms and closes a video meeting publisher that does not connect", async () => {
    vi.useFakeTimers();
    try {
      const socket = new FakeSocket();
      const meetingId = "4896f7c0-7143-48f9-9978-d1f6a342186f";
      const peer = createFakeRtcPeer("connecting");
      const bridge = createBridge({
        bootstrap: vi.fn(async () => validBootstrap(ticket)),
        createRtcPeer: () => peer,
        socket,
      });
      const connection = bridge.connect({ accountKey: "employee-session", onDisconnect: vi.fn(), onEvent: vi.fn() });
      await socketCreated(socket);
      socket.open();
      socket.message(JSON.stringify({ kind: "authenticated", protocolVersion: 1 }));
      const { session } = await connection;

      await session.publish({
        kind: "camera",
        roomId: `meeting:${meetingId}`,
        stream: {
          getAudioTracks: () => [],
          getVideoTracks: () => [{} as MediaStreamTrack],
        } as unknown as MediaStream,
      });
      await vi.advanceTimersByTimeAsync(19_000);
      answerMeetingMedia(socket, meetingId, "video", "publish");
      await vi.advanceTimersByTimeAsync(0);
      expect(peer.setRemoteDescription).toHaveBeenCalledWith({ sdp: "v=0\r\n", type: "answer" });

      await vi.advanceTimersByTimeAsync(19_999);
      expect(peer.close).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(peer.close).toHaveBeenCalledTimes(1);
      session.close("test_complete");
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes a meeting listener that never connects after its provider answer", async () => {
    vi.useFakeTimers();
    try {
      const socket = new FakeSocket();
      const meetingId = "4896f7c0-7143-48f9-9978-d1f6a342186f";
      const participantConnectionId = "58f2be04-75dc-4cb9-a7da-7c3d6daa20b4";
      const peer = createFakeRtcPeer("connecting");
      const startMeetingMedia = vi.fn(async () => acceptedCommand());
      const bridge = createBridge({
        bootstrap: vi.fn(async () => validBootstrap(ticket)),
        createRtcPeer: () => peer,
        socket,
        startMeetingMedia,
      });
      const connection = bridge.connect({ accountKey: "employee-session", onDisconnect: vi.fn(), onEvent: vi.fn() });
      await socketCreated(socket);
      socket.open();
      socket.message(JSON.stringify({ kind: "authenticated", protocolVersion: 1 }));
      const { session } = await connection;

      announceMeetingSource(socket, meetingId, participantConnectionId, "video");
      await vi.advanceTimersByTimeAsync(0);
      expect(startMeetingMedia).toHaveBeenCalledWith(
        "access-token",
        meetingId,
        "subscribe",
        expect.objectContaining({ mediaKind: "video", sourceConnectionId: participantConnectionId }),
        expect.any(AbortSignal),
      );
      answerMeetingMedia(socket, meetingId, "video", "subscribe", participantConnectionId, 2);
      await vi.advanceTimersByTimeAsync(0);
      expect(peer.setRemoteDescription).toHaveBeenCalledWith({ sdp: "v=0\r\n", type: "answer" });

      await vi.advanceTimersByTimeAsync(20_000);
      expect(peer.close).toHaveBeenCalledTimes(1);
      session.close("test_complete");
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports direct-call media only after the browser connects, and safely tracks reconnects and closure", async () => {
    const socket = new FakeSocket();
    const callId = "4896f7c0-7143-48f9-9978-d1f6a342186f";
    const peer = createFakeRtcPeer("connecting");
    const onCallMediaConnection = vi.fn();
    const startDirectAudio = vi.fn(async () => acceptedCommand());
    const bridge = createBridge({
      bootstrap: vi.fn(async () => validBootstrap(ticket)),
      createRtcPeer: () => peer,
      socket,
      startDirectAudio,
    });
    const connection = bridge.connect({ accountKey: "employee-session", onCallMediaConnection, onDisconnect: vi.fn(), onEvent: vi.fn() });
    await socketCreated(socket);
    socket.open();
    socket.message(JSON.stringify({ kind: "authenticated", protocolVersion: 1 }));
    const { session } = await connection;

    await session.publish({
      kind: "call_audio",
      roomId: `call:${callId}`,
      stream: { getAudioTracks: () => [{} as MediaStreamTrack] } as unknown as MediaStream,
    });
    expect(startDirectAudio).toHaveBeenCalledWith(
      "access-token",
      expect.objectContaining({ callId, offer: "v=0\r\n", transceiverMid: "0" }),
      expect.any(AbortSignal),
    );
    answerDirectCall(socket, callId);
    await vi.waitFor(() => expect(peer.setRemoteDescription).toHaveBeenCalledTimes(1));
    expect(onCallMediaConnection).not.toHaveBeenCalled();

    peer.setConnectionState("connected");
    await vi.waitFor(() => expect(onCallMediaConnection).toHaveBeenLastCalledWith({ callId, roomId: `call:${callId}`, state: "connected" }));
    peer.setConnectionState("disconnected");
    await vi.waitFor(() => expect(onCallMediaConnection).toHaveBeenLastCalledWith({ callId, roomId: `call:${callId}`, state: "reconnecting" }));
    peer.setConnectionState("connected");
    await vi.waitFor(() => expect(onCallMediaConnection).toHaveBeenLastCalledWith({ callId, roomId: `call:${callId}`, state: "connected" }));
    peer.setConnectionState("closed");
    await vi.waitFor(() => expect(onCallMediaConnection).toHaveBeenLastCalledWith({ callId, roomId: `call:${callId}`, state: "failed" }));
  });

  it("submits a direct-call offer without waiting for full ICE gathering", async () => {
    vi.useFakeTimers();
    try {
      const socket = new FakeSocket();
      const callId = "4896f7c0-7143-48f9-9978-d1f6a342186f";
      const peer = createFakeRtcPeer("connecting", "gathering");
      const startDirectAudio = vi.fn(async () => acceptedCommand());
      const bridge = createBridge({
        bootstrap: vi.fn(async () => validBootstrap(ticket)),
        createRtcPeer: () => peer,
        socket,
        startDirectAudio,
      });
      const connection = bridge.connect({ accountKey: "employee-session", onDisconnect: vi.fn(), onEvent: vi.fn() });
      await socketCreated(socket);
      socket.open();
      socket.message(JSON.stringify({ kind: "authenticated", protocolVersion: 1 }));
      const { session } = await connection;

      const publishing = session.publish({
        kind: "call_audio",
        roomId: `call:${callId}`,
        stream: { getAudioTracks: () => [{} as MediaStreamTrack] } as unknown as MediaStream,
      });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(10_000);

      await expect(publishing).resolves.toBeUndefined();
      expect(startDirectAudio).toHaveBeenCalledWith(
        "access-token",
        expect.objectContaining({ callId, offer: "v=0\r\n", transceiverMid: "0" }),
        expect.any(AbortSignal),
      );
      session.close("test_complete");
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails closed before sending a direct-call offer without a local transceiver MID", async () => {
    const socket = new FakeSocket();
    const callId = "4896f7c0-7143-48f9-9978-d1f6a342186f";
    const peer = createFakeRtcPeer("connecting", "complete", null);
    const startDirectAudio = vi.fn(async () => acceptedCommand());
    const bridge = createBridge({
      bootstrap: vi.fn(async () => validBootstrap(ticket)),
      createRtcPeer: () => peer,
      socket,
      startDirectAudio,
    });
    const connection = bridge.connect({ accountKey: "employee-session", onDisconnect: vi.fn(), onEvent: vi.fn() });
    await socketCreated(socket);
    socket.open();
    socket.message(JSON.stringify({ kind: "authenticated", protocolVersion: 1 }));
    const { session } = await connection;

    await expect(session.publish({
      kind: "call_audio",
      roomId: `call:${callId}`,
      stream: { getAudioTracks: () => [{} as MediaStreamTrack] } as unknown as MediaStream,
    })).rejects.toThrow("could not prepare direct-call audio");
    expect(startDirectAudio).not.toHaveBeenCalled();
    expect(peer.close).toHaveBeenCalledTimes(1);
  });

  it("sends the browser transceiver MID with a PTT publisher offer", async () => {
    const socket = new FakeSocket();
    const transmissionRequestId = "4896f7c0-7143-48f9-9978-d1f6a342186f";
    const startPtt = vi.fn(async () => acceptedCommand());
    const bridge = createBridge({
      bootstrap: vi.fn(async () => validBootstrap(ticket)),
      socket,
      startPtt,
    });
    const connection = bridge.connect({ accountKey: "employee-session", onDisconnect: vi.fn(), onEvent: vi.fn() });
    await socketCreated(socket);
    socket.open();
    socket.message(JSON.stringify({ kind: "authenticated", protocolVersion: 1 }));
    const { session } = await connection;

    await session.publish({
      channelReference: "dispatch",
      kind: "ptt",
      roomId: `ptt:${transmissionRequestId}`,
      stream: { getAudioTracks: () => [{} as MediaStreamTrack] } as unknown as MediaStream,
      transmissionRequestId,
    });
    expect(startPtt).toHaveBeenCalledWith(
      "access-token",
      expect.objectContaining({ offer: "v=0\r\n", transceiverMid: "0", transmissionRequestId }),
      expect.any(AbortSignal),
    );
  });

  it("submits a PTT offer without waiting for full ICE gathering", async () => {
    vi.useFakeTimers();
    try {
      const socket = new FakeSocket();
      const transmissionRequestId = "4896f7c0-7143-48f9-9978-d1f6a342186f";
      const peer = createFakeRtcPeer("connecting", "gathering");
      const startPtt = vi.fn(async () => acceptedCommand());
      const bridge = createBridge({
        bootstrap: vi.fn(async () => validBootstrap(ticket)),
        createRtcPeer: () => peer,
        socket,
        startPtt,
      });
      const connection = bridge.connect({ accountKey: "employee-session", onDisconnect: vi.fn(), onEvent: vi.fn() });
      await socketCreated(socket);
      socket.open();
      socket.message(JSON.stringify({ kind: "authenticated", protocolVersion: 1 }));
      const { session } = await connection;

      const publishing = session.publish({
        channelReference: "dispatch",
        kind: "ptt",
        roomId: `ptt:${transmissionRequestId}`,
        stream: { getAudioTracks: () => [{} as MediaStreamTrack] } as unknown as MediaStream,
        transmissionRequestId,
      });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(10_000);

      await expect(publishing).resolves.toBeUndefined();
      expect(startPtt).toHaveBeenCalledWith(
        "access-token",
        expect.objectContaining({ offer: "v=0\r\n", transceiverMid: "0", transmissionRequestId }),
        expect.any(AbortSignal),
      );
      session.close("test_complete");
    } finally {
      vi.useRealTimers();
    }
  });

  it("answers a remote direct-call subscription on its existing protected peer", async () => {
    const socket = new FakeSocket();
    const callId = "4896f7c0-7143-48f9-9978-d1f6a342186f";
    const peer = createFakeRtcPeer("connecting");
    const peerTransport = createFakePeerTransport();
    const sendCommand = vi.fn(async () => acceptedCommand());
    const bridge = createBridge({
      bootstrap: vi.fn(async () => validBootstrap(ticket)),
      createPeerTransport: peerTransport.factory,
      createRtcPeer: () => peer,
      sendCommand,
      socket,
    });
    const connection = bridge.connect({ accountKey: "employee-session", onDisconnect: vi.fn(), onEvent: vi.fn() });
    await socketCreated(socket);
    socket.open();
    socket.message(JSON.stringify({ kind: "authenticated", protocolVersion: 1 }));
    const { session } = await connection;

    await session.publish({
      kind: "call_audio",
      roomId: `call:${callId}`,
      stream: { getAudioTracks: () => [{} as MediaStreamTrack] } as unknown as MediaStream,
    });
    answerDirectCall(socket, callId);
    await vi.waitFor(() => expect(peer.setRemoteDescription).toHaveBeenCalledTimes(1));

    offerDirectCall(socket, callId);
    await vi.waitFor(() => expect(peer.setRemoteDescription).toHaveBeenLastCalledWith({ sdp: "v=0\r\n", type: "offer" }));
    await vi.waitFor(() => expect(peer.createAnswer).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(sendCommand).toHaveBeenCalledWith(
      "access-token",
      expect.objectContaining({
        kind: "media.answer",
        payload: expect.objectContaining({
          generation: 1,
          negotiationId: "d285bf11-15f6-4efe-b60f-5bd86765f451",
          peerHandle: "peer-listener",
        }),
        roomId: `call:${callId}`,
      }),
      expect.any(AbortSignal),
    ));
    expect(peerTransport.handleNegotiation).not.toHaveBeenCalled();
    expect(peer.createOffer).toHaveBeenCalledTimes(1);
  });

  it("answers a direct-call subscription while ICE gathering continues", async () => {
    vi.useFakeTimers();
    try {
      const socket = new FakeSocket();
      const callId = "4896f7c0-7143-48f9-9978-d1f6a342186f";
      const peer = createFakeRtcPeer("connecting", "gathering");
      const sendCommand = vi.fn(async () => acceptedCommand());
      const bridge = createBridge({
        bootstrap: vi.fn(async () => validBootstrap(ticket)),
        createRtcPeer: () => peer,
        sendCommand,
        socket,
      });
      const connection = bridge.connect({ accountKey: "employee-session", onDisconnect: vi.fn(), onEvent: vi.fn() });
      await socketCreated(socket);
      socket.open();
      socket.message(JSON.stringify({ kind: "authenticated", protocolVersion: 1 }));
      const { session } = await connection;

      await session.publish({
        kind: "call_audio",
        roomId: `call:${callId}`,
        stream: { getAudioTracks: () => [{} as MediaStreamTrack] } as unknown as MediaStream,
      });
      answerDirectCall(socket, callId);
      await vi.advanceTimersByTimeAsync(0);
      offerDirectCall(socket, callId);
      await vi.advanceTimersByTimeAsync(10_000);

      expect(sendCommand).toHaveBeenCalledWith(
        "access-token",
        expect.objectContaining({
          kind: "media.answer",
          payload: expect.objectContaining({
            generation: 1,
            negotiationId: "d285bf11-15f6-4efe-b60f-5bd86765f451",
            peerHandle: "peer-listener",
          }),
          roomId: `call:${callId}`,
        }),
        expect.any(AbortSignal),
      );
      expect(peer.close).not.toHaveBeenCalled();
      session.close("test_complete");
    } finally {
      vi.useRealTimers();
    }
  });

  it("answers a PTT listener while ICE gathering continues", async () => {
    vi.useFakeTimers();
    try {
      const socket = new FakeSocket();
      const transmissionRequestId = "4896f7c0-7143-48f9-9978-d1f6a342186f";
      const peer = createFakeRtcPeer("connecting", "gathering");
      const sendCommand = vi.fn(async () => acceptedCommand());
      const startPtt = vi.fn(async () => acceptedCommand());
      const bridge = createBridge({
        bootstrap: vi.fn(async () => validBootstrap(ticket)),
        createRtcPeer: () => peer,
        sendCommand,
        socket,
        startPtt,
      });
      const connection = bridge.connect({ accountKey: "employee-session", onDisconnect: vi.fn(), onEvent: vi.fn() });
      await socketCreated(socket);
      socket.open();
      socket.message(JSON.stringify({ kind: "authenticated", protocolVersion: 1 }));
      const { session } = await connection;

      startPttListener(socket, transmissionRequestId);
      await vi.advanceTimersByTimeAsync(0);
      expect(startPtt).toHaveBeenCalledWith(
        "access-token",
        expect.objectContaining({ mode: "listener", transmissionRequestId }),
        expect.any(AbortSignal),
      );
      offerPttListener(socket, transmissionRequestId);
      await vi.advanceTimersByTimeAsync(10_000);

      expect(sendCommand).toHaveBeenCalledWith(
        "access-token",
        expect.objectContaining({
          kind: "media.answer",
          payload: expect.objectContaining({
            generation: 1,
            negotiationId: "d285bf11-15f6-4efe-b60f-5bd86765f451",
            peerHandle: "peer-listener",
          }),
          roomId: `ptt:${transmissionRequestId}`,
        }),
        expect.any(AbortSignal),
      );
      expect(peer.close).not.toHaveBeenCalled();
      session.close("test_complete");
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails and closes a direct-call peer that never reaches browser media connection", async () => {
    vi.useFakeTimers();
    try {
      const socket = new FakeSocket();
      const callId = "4896f7c0-7143-48f9-9978-d1f6a342186f";
      const peer = createFakeRtcPeer("connecting");
      const onCallMediaConnection = vi.fn();
      const bridge = createBridge({
        bootstrap: vi.fn(async () => validBootstrap(ticket)),
        createRtcPeer: () => peer,
        socket,
      });
      const connection = bridge.connect({ accountKey: "employee-session", onCallMediaConnection, onDisconnect: vi.fn(), onEvent: vi.fn() });
      await Promise.resolve();
      await Promise.resolve();
      socket.open();
      socket.message(JSON.stringify({ kind: "authenticated", protocolVersion: 1 }));
      const { session } = await connection;

      await session.publish({
        kind: "call_audio",
        roomId: `call:${callId}`,
        stream: { getAudioTracks: () => [{} as MediaStreamTrack] } as unknown as MediaStream,
      });
      await vi.advanceTimersByTimeAsync(20_000);

      expect(peer.close).toHaveBeenCalledTimes(1);
      expect(onCallMediaConnection).toHaveBeenCalledWith({ callId, roomId: `call:${callId}`, state: "failed" });
      session.close("test_complete");
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails closed if an active direct-call peer does not recover after disconnection", async () => {
    vi.useFakeTimers();
    try {
      const socket = new FakeSocket();
      const callId = "4896f7c0-7143-48f9-9978-d1f6a342186f";
      const peer = createFakeRtcPeer("connecting");
      const onCallMediaConnection = vi.fn();
      const bridge = createBridge({
        bootstrap: vi.fn(async () => validBootstrap(ticket)),
        createRtcPeer: () => peer,
        socket,
      });
      const connection = bridge.connect({ accountKey: "employee-session", onCallMediaConnection, onDisconnect: vi.fn(), onEvent: vi.fn() });
      await Promise.resolve();
      await Promise.resolve();
      socket.open();
      socket.message(JSON.stringify({ kind: "authenticated", protocolVersion: 1 }));
      const { session } = await connection;
      await session.publish({
        kind: "call_audio",
        roomId: `call:${callId}`,
        stream: { getAudioTracks: () => [{} as MediaStreamTrack] } as unknown as MediaStream,
      });

      peer.setConnectionState("connected");
      peer.setConnectionState("disconnected");
      await vi.advanceTimersByTimeAsync(20_000);

      expect(onCallMediaConnection).toHaveBeenCalledWith({ callId, roomId: `call:${callId}`, state: "reconnecting" });
      expect(onCallMediaConnection).toHaveBeenLastCalledWith({ callId, roomId: `call:${callId}`, state: "failed" });
      expect(peer.close).toHaveBeenCalledTimes(1);
      session.close("test_complete");
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails a direct call safely when the provider answer cannot be applied", async () => {
    const socket = new FakeSocket();
    const callId = "4896f7c0-7143-48f9-9978-d1f6a342186f";
    const peer = createFakeRtcPeer("connecting");
    vi.mocked(peer.setRemoteDescription).mockRejectedValueOnce(new Error("provider SDP failure"));
    const onCallMediaConnection = vi.fn();
    const bridge = createBridge({
      bootstrap: vi.fn(async () => validBootstrap(ticket)),
      createRtcPeer: () => peer,
      socket,
    });
    const connection = bridge.connect({ accountKey: "employee-session", onCallMediaConnection, onDisconnect: vi.fn(), onEvent: vi.fn() });
    await socketCreated(socket);
    socket.open();
    socket.message(JSON.stringify({ kind: "authenticated", protocolVersion: 1 }));
    const { session } = await connection;
    await session.publish({
      kind: "call_audio",
      roomId: `call:${callId}`,
      stream: { getAudioTracks: () => [{} as MediaStreamTrack] } as unknown as MediaStream,
    });

    answerDirectCall(socket, callId);
    await vi.waitFor(() => expect(peer.close).toHaveBeenCalledTimes(1));
    expect(onCallMediaConnection).toHaveBeenCalledWith({ callId, roomId: `call:${callId}`, state: "failed" });
    expect(socket.closedWith).toBeNull();
  });

  it("converts peer transport answers and readiness into validated protected commands", async () => {
    const socket = new FakeSocket();
    const peerTransport = createFakePeerTransport();
    const sendCommand = vi.fn(async () => acceptedCommand());
    const bridge = createBridge({
      bootstrap: vi.fn(async () => validBootstrap(ticket)),
      createPeerTransport: peerTransport.factory,
      sendCommand,
      socket,
    });
    const connection = bridge.connect({ accountKey: "employee-session", onDisconnect: vi.fn(), onEvent: vi.fn() });
    await socketCreated(socket);
    socket.open();
    socket.message(JSON.stringify({ kind: "authenticated", protocolVersion: 1 }));
    await connection;

    await peerTransport.callbacks?.onAnswer({
      answer: "v=0\r\n",
      generation: 2,
      negotiationId: "d285bf11-15f6-4efe-b60f-4ab891637342",
      peerHandle: "peer-1",
      roomId: "room-1",
    });
    await peerTransport.callbacks?.onReady({
      callId: "4896f7c0-7143-48f9-9978-d1f6a342186f",
      generation: 2,
      inputKind: "audio",
      negotiationId: "d285bf11-15f6-4efe-b60f-4ab891637342",
      peerHandle: "peer-1",
      roomId: "room-1",
    });

    expect((sendCommand.mock.calls as unknown as Array<[string, unknown, AbortSignal]>).map(([, command]) => command)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "media.answer", payload: expect.objectContaining({ generation: 2, peerHandle: "peer-1" }), roomId: "room-1" }),
      expect.objectContaining({ kind: "media.ready", payload: expect.objectContaining({ inputKind: "audio", peerHandle: "peer-1" }), roomId: "room-1" }),
    ]));
  });

  it("reports unexpected post-authentication closure without exposing provider detail", async () => {
    const socket = new FakeSocket();
    const onDisconnect = vi.fn();
    const bridge = createBridge({ bootstrap: vi.fn(async () => validBootstrap(ticket)), socket });
    const connection = bridge.connect({ accountKey: "employee-session", onDisconnect, onEvent: vi.fn() });
    await socketCreated(socket);
    socket.open();
    socket.message(JSON.stringify({ kind: "authenticated", protocolVersion: 1 }));
    await connection;
    socket.remoteClose(1011, "private provider failure");
    expect(onDisconnect).toHaveBeenCalledWith(expect.not.stringContaining("provider"), true);
  });

  it("requests a snapshot and sends 15-second heartbeats only while the socket is active", async () => {
    vi.useFakeTimers();
    try {
      const socket = new FakeSocket();
      const bridge = createBridge({ bootstrap: vi.fn(async () => validBootstrap(ticket)), socket });
      const connection = bridge.connect({ accountKey: "employee-session", onDisconnect: vi.fn(), onEvent: vi.fn() });
      await Promise.resolve();
      await Promise.resolve();
      socket.open();
      socket.message(JSON.stringify({ kind: "authenticated", protocolVersion: 1 }));
      const { session } = await connection;
      expect(JSON.parse(socket.sent[1])).toMatchObject({ kind: "snapshot.request", payload: {} });
      socket.message(JSON.stringify({
        correlationId: "a02f99bc-6b0b-40a3-8916-b2c273853e15",
        kind: "snapshot",
        protocolVersion: 1,
        status: "unavailable",
      }));
      await vi.advanceTimersByTimeAsync(15_000);
      expect(JSON.parse(socket.sent[2])).toMatchObject({ kind: "heartbeat", payload: {} });
      socket.message(JSON.stringify({
        connectionEpoch: 1,
        correlationId: "58f2be04-75dc-4cb9-a7da-7c3d6daa20b4",
        kind: "heartbeat.ack",
        protocolVersion: 1,
        serverTime: "2026-09-19T21:00:15.000Z",
      }));
      expect(socket.closedWith).toBeNull();
      session.close("test_complete");
      await vi.advanceTimersByTimeAsync(30_000);
      expect(socket.sent).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retires a stale control socket after two unanswered heartbeat intervals so the controller can reconnect", async () => {
    vi.useFakeTimers();
    try {
      const socket = new FakeSocket();
      const onDisconnect = vi.fn();
      const bridge = createBridge({ bootstrap: vi.fn(async () => validBootstrap(ticket)), socket });
      const connection = bridge.connect({ accountKey: "employee-session", onDisconnect, onEvent: vi.fn() });
      await Promise.resolve();
      await Promise.resolve();
      socket.open();
      socket.message(JSON.stringify({ kind: "authenticated", protocolVersion: 1 }));
      await connection;

      await vi.advanceTimersByTimeAsync(45_000);

      expect(socket.sent.map((frame) => JSON.parse(frame).kind)).toEqual([
        "auth",
        "snapshot.request",
        "heartbeat",
        "heartbeat",
      ]);
      expect(socket.closedWith).toMatchObject({ code: 4501 });
      expect(onDisconnect).toHaveBeenCalledOnce();
      expect(onDisconnect).toHaveBeenCalledWith("Communications stopped responding. Reconnecting.", true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a heartbeat acknowledgement from a different connection epoch", async () => {
    vi.useFakeTimers();
    try {
      const socket = new FakeSocket();
      const onDisconnect = vi.fn();
      const bridge = createBridge({ bootstrap: vi.fn(async () => validBootstrap(ticket)), socket });
      const connection = bridge.connect({ accountKey: "employee-session", onDisconnect, onEvent: vi.fn() });
      await Promise.resolve();
      await Promise.resolve();
      socket.open();
      socket.message(JSON.stringify({ kind: "authenticated", protocolVersion: 1 }));
      await connection;

      await vi.advanceTimersByTimeAsync(15_000);
      socket.message(heartbeatAcknowledgement(2));
      await vi.advanceTimersByTimeAsync(30_000);

      // The wrong-epoch acknowledgement above must not hide a dead socket.
      expect(socket.closedWith).toMatchObject({ code: 4501 });
      expect(onDisconnect).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not force a reconnect while matching heartbeat acknowledgements continue to arrive", async () => {
    vi.useFakeTimers();
    try {
      const socket = new FakeSocket();
      const onDisconnect = vi.fn();
      const bridge = createBridge({ bootstrap: vi.fn(async () => validBootstrap(ticket)), socket });
      const connection = bridge.connect({ accountKey: "employee-session", onDisconnect, onEvent: vi.fn() });
      await Promise.resolve();
      await Promise.resolve();
      socket.open();
      socket.message(JSON.stringify({ kind: "authenticated", protocolVersion: 1 }));
      const { session } = await connection;

      for (let heartbeat = 0; heartbeat < 4; heartbeat += 1) {
        await vi.advanceTimersByTimeAsync(15_000);
        socket.message(heartbeatAcknowledgement(1));
      }

      expect(socket.closedWith).toBeNull();
      expect(onDisconnect).not.toHaveBeenCalled();
      session.close("test_complete");
    } finally {
      vi.useRealTimers();
    }
  });

  it("renews authorization every 45 seconds while the connection remains active", async () => {
    vi.useFakeTimers();
    try {
      const socket = new FakeSocket();
      const refreshAuthorization = vi.fn(async () => ({
        refreshedConnections: 1,
        requestId: "d285bf11-15f6-4efe-b60f-4ab891637342",
      }));
      const bridge = createBridge({
        bootstrap: vi.fn(async () => validBootstrap(ticket)),
        refreshAuthorization,
        socket,
      });
      const connection = bridge.connect({ accountKey: "employee-session", onDisconnect: vi.fn(), onEvent: vi.fn() });
      await Promise.resolve();
      await Promise.resolve();
      socket.open();
      socket.message(JSON.stringify({ kind: "authenticated", protocolVersion: 1 }));
      await connection;

      for (let heartbeat = 0; heartbeat < 3; heartbeat += 1) await advanceHealthyHeartbeat(socket);
      expect(refreshAuthorization).toHaveBeenCalledTimes(1);
      expect(refreshAuthorization).toHaveBeenCalledWith("access-token", expect.any(AbortSignal));
      for (let heartbeat = 0; heartbeat < 3; heartbeat += 1) await advanceHealthyHeartbeat(socket);
      expect(refreshAuthorization).toHaveBeenCalledTimes(2);
      expect(socket.closedWith).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the latest browser token when scheduled authorization renewal runs", async () => {
    vi.useFakeTimers();
    try {
      let accessToken = "initial-access-token";
      const socket = new FakeSocket();
      const refreshAuthorization = vi.fn(async () => ({
        refreshedConnections: 1,
        requestId: "d285bf11-15f6-4efe-b60f-4ab891637342",
      }));
      const bridge = createBridge({
        bootstrap: vi.fn(async () => validBootstrap(ticket)),
        getAccessToken: () => accessToken,
        refreshAuthorization,
        socket,
      });
      const connection = bridge.connect({ accountKey: "employee-session", onDisconnect: vi.fn(), onEvent: vi.fn() });
      await Promise.resolve();
      await Promise.resolve();
      socket.open();
      socket.message(JSON.stringify({ kind: "authenticated", protocolVersion: 1 }));
      await connection;

      accessToken = "refreshed-access-token";
      for (let heartbeat = 0; heartbeat < 3; heartbeat += 1) await advanceHealthyHeartbeat(socket);

      expect(refreshAuthorization).toHaveBeenCalledWith("refreshed-access-token", expect.any(AbortSignal));
      expect(socket.closedWith).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes the socket when authorization renewal fails or refreshes no connection", async () => {
    vi.useFakeTimers();
    try {
      for (const refreshAuthorization of [
        vi.fn(async () => { throw new Error("private failure"); }),
        vi.fn(async () => ({
          refreshedConnections: 0,
          requestId: "d285bf11-15f6-4efe-b60f-4ab891637342",
        })),
      ]) {
        const socket = new FakeSocket();
        const bridge = createBridge({
          bootstrap: vi.fn(async () => validBootstrap(ticket)),
          refreshAuthorization,
          socket,
        });
        const connection = bridge.connect({ accountKey: "employee-session", onDisconnect: vi.fn(), onEvent: vi.fn() });
        await Promise.resolve();
        await Promise.resolve();
        socket.open();
        socket.message(JSON.stringify({ kind: "authenticated", protocolVersion: 1 }));
        await connection;
        for (let heartbeat = 0; heartbeat < 3; heartbeat += 1) await advanceHealthyHeartbeat(socket);
        expect(socket.closedWith).toEqual({ code: 4403, reason: "Communications authorization expired." });
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts an in-flight authorization refresh when the session closes", async () => {
    vi.useFakeTimers();
    try {
      const socket = new FakeSocket();
      const observed: { refreshSignal?: AbortSignal } = {};
      const refreshAuthorization = vi.fn((_accessToken: string, signal: AbortSignal) => {
        observed.refreshSignal = signal;
        return new Promise(() => undefined);
      });
      const bridge = createBridge({
        bootstrap: vi.fn(async () => validBootstrap(ticket)),
        refreshAuthorization,
        socket,
      });
      const connection = bridge.connect({ accountKey: "employee-session", onDisconnect: vi.fn(), onEvent: vi.fn() });
      await Promise.resolve();
      await Promise.resolve();
      socket.open();
      socket.message(JSON.stringify({ kind: "authenticated", protocolVersion: 1 }));
      const { session } = await connection;
      for (let heartbeat = 0; heartbeat < 3; heartbeat += 1) await advanceHealthyHeartbeat(socket);
      expect(observed.refreshSignal).toBeDefined();
      expect(observed.refreshSignal?.aborted).toBe(false);
      session.close("logout");
      expect(observed.refreshSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

function validBootstrap(value: string) {
  return {
    connection: {
      expiresAt,
      protocolVersion: 1,
      routeHandle: "11111111-1111-4111-8111-111111111111.22222222-2222-4222-8222-222222222222",
      socketPath: "/api/comms/v1/connect",
      ticket: value,
    },
    requestId: "d285bf11-15f6-4efe-b60f-4ab891637342",
  };
}

function heartbeatAcknowledgement(connectionEpoch: number) {
  return JSON.stringify({
    connectionEpoch,
    correlationId: "58f2be04-75dc-4cb9-a7da-7c3d6daa20b4",
    kind: "heartbeat.ack",
    protocolVersion: 1,
    serverTime: "2026-09-19T21:00:15.000Z",
  });
}

async function advanceHealthyHeartbeat(socket: FakeSocket, connectionEpoch = 1) {
  await vi.advanceTimersByTimeAsync(15_000);
  socket.message(heartbeatAcknowledgement(connectionEpoch));
}

async function socketCreated(socket: FakeSocket) {
  await vi.waitFor(() => expect(socket.url).not.toBe(""));
}

function announceMeetingSource(
  socket: FakeSocket,
  meetingId: string,
  participantConnectionId: string,
  mediaKind: "audio" | "screen" | "video",
) {
  socket.message(JSON.stringify({
    eventId: "8d2f99e1-0915-4517-88e0-c344ba284df8",
    kind: "media.source.available",
    payload: {
      callId: meetingId,
      mediaKind,
      participantConnectionId,
      trackReference: `meeting-${mediaKind}-track`,
    },
    protocolVersion: 1,
    roomEpoch: 1,
    roomId: `meeting:${meetingId}`,
    roomSeq: 1,
    serverTime: "2026-09-19T21:00:01.000Z",
  }));
}

function answerMeetingMedia(
  socket: FakeSocket,
  meetingId: string,
  mediaKind: "audio" | "screen" | "video",
  direction: "publish" | "subscribe",
  participantConnectionId?: string,
  roomSeq = 1,
) {
  const publicationKind = mediaKind === "audio" ? "call_audio" : mediaKind === "video" ? "camera" : "screen";
  socket.message(JSON.stringify({
    eventId: "73f004e3-34e3-48b2-9bca-7be78c4f04a6",
    kind: "media.negotiation",
    payload: {
      callId: meetingId,
      description: "v=0\r\n",
      descriptionType: "answer",
      direction,
      expiresAt: "2026-09-19T21:00:30.000Z",
      generation: 1,
      iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }],
      negotiationId: "d285bf11-15f6-4efe-b60f-5bd86765f451",
      peerHandle: direction === "publish" ? "peer-publisher" : "peer-listener",
      trackBindings: [{
        mediaKind,
        ...(participantConnectionId ? { participantConnectionId } : {}),
        publicationKind,
        role: direction === "publish" ? "local" : "remote",
        trackReference: `meeting-${mediaKind}-track`,
        transceiverMid: "0",
      }],
    },
    protocolVersion: 1,
    roomEpoch: 1,
    roomId: `meeting:${meetingId}`,
    roomSeq,
    serverTime: "2026-09-19T21:00:02.000Z",
  }));
}

function startPttListener(socket: FakeSocket, transmissionRequestId: string) {
  socket.message(JSON.stringify({
    eventId: "8d2f99e1-0915-4517-88e0-c344ba284df8",
    kind: "transmission.started",
    payload: { scope: "dispatch", transmissionRequestId },
    protocolVersion: 1,
    roomEpoch: 1,
    roomId: `ptt:${transmissionRequestId}`,
    roomSeq: 1,
    serverTime: "2026-09-19T21:00:01.000Z",
  }));
}

function offerPttListener(socket: FakeSocket, transmissionRequestId: string, expiresAt = "2026-09-19T21:00:30.000Z") {
  socket.message(JSON.stringify({
    eventId: "73f004e3-34e3-48b2-9bca-7be78c4f04a6",
    kind: "media.negotiation",
    payload: {
      callId: transmissionRequestId,
      description: "v=0\r\n",
      descriptionType: "offer",
      direction: "subscribe",
      expiresAt,
      generation: 1,
      iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }],
      negotiationId: "d285bf11-15f6-4efe-b60f-5bd86765f451",
      peerHandle: "peer-listener",
      trackBindings: [{
        mediaKind: "audio",
        participantConnectionId: "58f2be04-75dc-4cb9-a7da-7c3d6daa20b4",
        publicationKind: "ptt",
        role: "remote",
        trackReference: "track-1",
        transceiverMid: "0",
      }],
    },
    protocolVersion: 1,
    roomEpoch: 1,
    roomId: `ptt:${transmissionRequestId}`,
    roomSeq: 2,
    serverTime: "2026-09-19T21:00:02.000Z",
  }));
}

function answerDirectCall(socket: FakeSocket, callId: string) {
  socket.message(JSON.stringify({
    eventId: "73f004e3-34e3-48b2-9bca-7be78c4f04a6",
    kind: "media.negotiation",
    payload: {
      callId,
      description: "v=0\r\n",
      descriptionType: "answer",
      direction: "publish",
      expiresAt: "2026-09-19T21:00:30.000Z",
      generation: 1,
      iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }],
      negotiationId: "d285bf11-15f6-4efe-b60f-5bd86765f451",
      peerHandle: "peer-publisher",
      trackBindings: [{
        mediaKind: "audio",
        publicationKind: "call_audio",
        role: "local",
        trackReference: "call-audio",
        transceiverMid: "0",
      }],
    },
    protocolVersion: 1,
    roomEpoch: 1,
    roomId: `call:${callId}`,
    roomSeq: 1,
    serverTime: "2026-09-19T21:00:02.000Z",
  }));
}

function offerDirectCall(socket: FakeSocket, callId: string) {
  socket.message(JSON.stringify({
    eventId: "73f004e3-34e3-48b2-9bca-7be78c4f04a6",
    kind: "media.negotiation",
    payload: {
      callId,
      description: "v=0\r\n",
      descriptionType: "offer",
      direction: "subscribe",
      expiresAt: "2026-09-19T21:00:30.000Z",
      generation: 1,
      iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }],
      negotiationId: "d285bf11-15f6-4efe-b60f-5bd86765f451",
      peerHandle: "peer-listener",
      trackBindings: [{
        mediaKind: "audio",
        participantConnectionId: "58f2be04-75dc-4cb9-a7da-7c3d6daa20b4",
        publicationKind: "call_audio",
        role: "remote",
        trackReference: "remote-call-audio",
        transceiverMid: "0",
      }],
    },
    protocolVersion: 1,
    roomEpoch: 1,
    roomId: `call:${callId}`,
    roomSeq: 2,
    serverTime: "2026-09-19T21:00:03.000Z",
  }));
}

function createBridge({ acknowledgePttListenerReady, bootstrap, createPeerTransport, createRtcPeer, getAccessToken, now, peerTransport, prepareMeetingMedia, preparePtt, refreshAuthorization, reportPttListenerFailure, sendCommand, socket, sockets, startDirectAudio, startMeetingMedia, startPtt }: {
  acknowledgePttListenerReady?: (accessToken: string, input: unknown, signal: AbortSignal) => Promise<unknown>;
  bootstrap: (accessToken: string, signal: AbortSignal) => Promise<unknown>;
  createPeerTransport?: SygSphereCommunicationsPeerTransportFactory;
  createRtcPeer?: (configuration: RTCConfiguration) => RTCPeerConnection;
  getAccessToken?: () => string | null;
  now?: () => number;
  peerTransport?: SygSphereCommunicationsPeerTransportAdapter;
  prepareMeetingMedia?: (accessToken: string, meetingId: string, input: unknown, signal: AbortSignal) => Promise<unknown>;
  preparePtt?: (accessToken: string, input: unknown, signal: AbortSignal) => Promise<unknown>;
  refreshAuthorization?: (accessToken: string, signal: AbortSignal) => Promise<unknown>;
  reportPttListenerFailure?: (accessToken: string, input: unknown, signal: AbortSignal) => Promise<unknown>;
  sendCommand?: (accessToken: string, command: unknown, signal: AbortSignal) => Promise<unknown>;
  socket?: FakeSocket;
  sockets?: FakeSocket[];
  startDirectAudio?: (accessToken: string, input: unknown, signal: AbortSignal) => Promise<unknown>;
  startMeetingMedia?: (accessToken: string, meetingId: string, operation: "publish" | "subscribe", input: unknown, signal: AbortSignal) => Promise<unknown>;
  startPtt?: (accessToken: string, input: unknown, signal: AbortSignal) => Promise<unknown>;
}) {
  let index = 0;
  return new SygSphereCommunicationsSocketBridge(getAccessToken ?? (() => "access-token"), {
    acknowledgePttListenerReady: acknowledgePttListenerReady ?? vi.fn(async () => acceptedCommand()),
    reportPttListenerFailure: reportPttListenerFailure ?? vi.fn(async () => acceptedCommand()),
    bootstrap,
    clearTimer: (timer) => clearTimeout(timer),
    createPeerTransport: createPeerTransport ?? (() => peerTransport ?? createFakePeerTransport().adapter),
    createRtcPeer: createRtcPeer ?? (() => createFakeRtcPeer()),
    createStream: (tracks) => ({ getTracks: () => tracks } as unknown as MediaStream),
    createSocket: (url, protocols) => {
      const selected = sockets?.[index++] ?? socket;
      if (!selected) throw new Error("No test socket configured.");
      selected.url = url;
      selected.protocols = protocols;
      return selected;
    },
    location: () => ({ origin: "https://sygilant.us", protocol: "https:" }),
    now: now ?? (() => Date.parse("2026-09-19T21:00:00.000Z")),
    getDirectCallContext: vi.fn(async () => ({ conversationReference: "4896f7c0-7143-48f9-9978-d1f6a342186f", requestId: "d285bf11-15f6-4efe-b60f-5bd86765f451" })),
    prepareDirectAudio: vi.fn(async () => ({ iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }], requestId: "d285bf11-15f6-4efe-b60f-5bd86765f451" })),
    prepareMeetingMedia: prepareMeetingMedia ?? vi.fn(async () => ({ iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }], requestId: "d285bf11-15f6-4efe-b60f-5bd86765f451" })),
    preparePtt: preparePtt ?? vi.fn(async () => ({ iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }], requestId: "d285bf11-15f6-4efe-b60f-5bd86765f451" })),
    refreshAuthorization: refreshAuthorization ?? vi.fn(async () => ({
      refreshedConnections: 1,
      requestId: "d285bf11-15f6-4efe-b60f-4ab891637342",
    })),
    sendCommand: sendCommand ?? vi.fn(async () => acceptedCommand()),
    setTimer: (callback, delay) => setTimeout(callback, delay),
    startDirectAudio: startDirectAudio ?? vi.fn(async () => acceptedCommand()),
    startMeetingMedia: startMeetingMedia ?? vi.fn(async () => acceptedCommand()),
    startPtt: startPtt ?? vi.fn(async () => acceptedCommand()),
    stopMeetingMedia: vi.fn(async () => acceptedCommand()),
  });
}

type FakeRtcPeer = RTCPeerConnection & Readonly<{
  setConnectionState: (state: RTCPeerConnectionState) => void;
}>;

function createFakeRtcPeer(
  initialConnectionState: RTCPeerConnectionState = "connected",
  initialIceGatheringState: RTCIceGatheringState = "complete",
  localTransceiverMid: string | null = "0",
): FakeRtcPeer {
  const listeners = new Map<string, Array<(event: Event) => void>>();
  const transceivers: RTCRtpTransceiver[] = [];
  const peer = {
    connectionState: initialConnectionState,
    iceGatheringState: initialIceGatheringState,
    localDescription: null as RTCSessionDescriptionInit | null,
    addEventListener: (type: string, listener: (event: Event) => void) => {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    removeEventListener: (type: string, listener: (event: Event) => void) => {
      listeners.set(type, (listeners.get(type) ?? []).filter((item) => item !== listener));
    },
    addTrack: vi.fn((track: MediaStreamTrack) => {
      transceivers.push({ mid: localTransceiverMid, sender: { track } } as unknown as RTCRtpTransceiver);
    }),
    addTransceiver: vi.fn(),
    close: vi.fn(),
    createAnswer: vi.fn(async () => ({ sdp: "v=0\r\n", type: "answer" as const })),
    createOffer: vi.fn(async () => ({ sdp: "v=0\r\n", type: "offer" as const })),
    getTransceivers: vi.fn(() => transceivers),
    setLocalDescription: vi.fn(async (description: RTCSessionDescriptionInit) => { peer.localDescription = description; }),
    setRemoteDescription: vi.fn(async () => undefined),
  };
  return Object.assign(peer, {
    setConnectionState: (state: RTCPeerConnectionState) => {
      peer.connectionState = state;
      for (const listener of listeners.get("connectionstatechange") ?? []) listener({} as Event);
    },
  }) as unknown as FakeRtcPeer;
}

function acceptedCommand() {
  return {
    outcome: "accepted",
    requestId: "d285bf11-15f6-4efe-b60f-4ab891637342",
  };
}

function createFakePeerTransport() {
  let callbacks: Parameters<SygSphereCommunicationsPeerTransportFactory>[0] | null = null;
  const handleNegotiation = vi.fn(async () => undefined);
  const adapter: SygSphereCommunicationsPeerTransportAdapter = {
    closeAll: vi.fn(),
    closeRoom: vi.fn(),
    handleNegotiation,
    registerPublication: vi.fn(async () => undefined),
    removePublication: vi.fn(async () => undefined),
  };
  const factory: SygSphereCommunicationsPeerTransportFactory = (input) => {
    callbacks = input;
    return adapter;
  };
  return {
    adapter,
    get callbacks() { return callbacks; },
    factory,
    handleNegotiation,
  };
}

class FakeSocket {
  readyState = 0;
  sent: string[] = [];
  url = "";
  protocols: string | string[] | undefined;
  closedWith: { code?: number; reason?: string } | null = null;
  private listeners = new Map<string, Array<(event: never) => void>>();

  addEventListener(type: string, listener: (event: never) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  close(code?: number, reason?: string) {
    if (code !== undefined && code !== 1000 && (code < 3000 || code > 4999)) {
      throw new DOMException("Invalid browser WebSocket close code.", "InvalidAccessError");
    }
    this.readyState = 3;
    this.closedWith = { code, reason };
  }

  send(data: string) {
    if (this.readyState !== 1) throw new Error("Socket is not open.");
    this.sent.push(data);
  }

  open() {
    this.readyState = 1;
    this.emit("open", undefined);
  }

  message(data: string) {
    this.emit("message", { data });
  }

  remoteClose(code: number, reason: string) {
    this.readyState = 3;
    this.emit("close", { code, reason });
  }

  private emit(type: string, event: unknown) {
    for (const listener of this.listeners.get(type) ?? []) listener(event as never);
  }
}
