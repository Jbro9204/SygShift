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
    expect(rejectedSocket.closedWith?.code).toBe(1008);
  });

  it("validates outbound commands and forwards only canonical server events", async () => {
    const socket = new FakeSocket();
    const onEvent = vi.fn();
    const bridge = createBridge({ bootstrap: vi.fn(async () => validBootstrap(ticket)), socket });
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
    expect(JSON.parse(socket.sent.at(-1) ?? "null")).toMatchObject({ connectionEpoch: 1, kind: "floor.request" });

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

  it("converts peer transport answers and readiness into validated socket commands", async () => {
    const socket = new FakeSocket();
    const peerTransport = createFakePeerTransport();
    const bridge = createBridge({
      bootstrap: vi.fn(async () => validBootstrap(ticket)),
      createPeerTransport: peerTransport.factory,
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

    expect(socket.sent.map((item) => JSON.parse(item))).toEqual(expect.arrayContaining([
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

      await vi.advanceTimersByTimeAsync(45_000);
      expect(refreshAuthorization).toHaveBeenCalledTimes(1);
      expect(refreshAuthorization).toHaveBeenCalledWith("access-token", expect.any(AbortSignal));
      await vi.advanceTimersByTimeAsync(45_000);
      expect(refreshAuthorization).toHaveBeenCalledTimes(2);
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
        await vi.advanceTimersByTimeAsync(45_000);
        expect(socket.closedWith).toEqual({ code: 1008, reason: "Communications authorization expired." });
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
      await vi.advanceTimersByTimeAsync(45_000);
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
    connection: { expiresAt, protocolVersion: 1, socketPath: "/api/comms/v1/connect", ticket: value },
    requestId: "d285bf11-15f6-4efe-b60f-4ab891637342",
  };
}

async function socketCreated(socket: FakeSocket) {
  await vi.waitFor(() => expect(socket.url).not.toBe(""));
}

function createBridge({ bootstrap, createPeerTransport, peerTransport, refreshAuthorization, socket, sockets }: {
  bootstrap: (accessToken: string, signal: AbortSignal) => Promise<unknown>;
  createPeerTransport?: SygSphereCommunicationsPeerTransportFactory;
  peerTransport?: SygSphereCommunicationsPeerTransportAdapter;
  refreshAuthorization?: (accessToken: string, signal: AbortSignal) => Promise<unknown>;
  socket?: FakeSocket;
  sockets?: FakeSocket[];
}) {
  let index = 0;
  return new SygSphereCommunicationsSocketBridge(() => "access-token", {
    bootstrap,
    clearTimer: (timer) => clearTimeout(timer),
    createPeerTransport: createPeerTransport ?? (() => peerTransport ?? createFakePeerTransport().adapter),
    createSocket: (url) => {
      const selected = sockets?.[index++] ?? socket;
      if (!selected) throw new Error("No test socket configured.");
      selected.url = url;
      return selected;
    },
    location: () => ({ origin: "https://sygilant.us", protocol: "https:" }),
    now: () => Date.parse("2026-09-19T21:00:00.000Z"),
    refreshAuthorization: refreshAuthorization ?? vi.fn(async () => ({
      refreshedConnections: 1,
      requestId: "d285bf11-15f6-4efe-b60f-4ab891637342",
    })),
    setTimer: (callback, delay) => setTimeout(callback, delay),
  });
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
  closedWith: { code?: number; reason?: string } | null = null;
  private listeners = new Map<string, Array<(event: never) => void>>();

  addEventListener(type: string, listener: (event: never) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  close(code?: number, reason?: string) {
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
