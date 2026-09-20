import { z } from "zod";
import {
  parseSygSphereCommsCommand,
  SYGSPHERE_COMMS_EVENT_PAYLOAD_SCHEMAS,
  SYGSPHERE_COMMS_PROTOCOL_VERSION,
  type SygSphereCommsEvent,
} from "../../shared/sygsphere-communications/v1/contract";
import { sygSphereCommunicationsApiRequest } from "../data/sygsphereCommunications";
import type {
  CommunicationsCoordinatorBridge,
  CommunicationsCoordinatorSession,
  CommunicationsPublicationKind,
} from "./sygsphereCommunicationsController";
import { parseSygSphereCommunicationsEvent } from "./sygsphereCommunicationsState";
import {
  SygSphereCommunicationsPeerTransport,
  type CommunicationsMediaAnswer,
  type CommunicationsMediaNegotiation,
  type CommunicationsMediaReady,
  type CommunicationsRemoteTrack,
} from "./sygsphereCommunicationsPeerTransport";

const socketPath = "/api/comms/v1/connect";
const openingTimeoutMilliseconds = 5_000;
const heartbeatMilliseconds = 15_000;
const authorizationRefreshMilliseconds = 45_000;
const bootstrapSchema = z.object({
  connection: z.object({
    expiresAt: z.iso.datetime(),
    protocolVersion: z.literal(SYGSPHERE_COMMS_PROTOCOL_VERSION),
    socketPath: z.literal(socketPath),
    ticket: z.string().regex(/^[A-Za-z0-9_-]{43,128}$/),
  }).strict(),
  requestId: z.uuid(),
}).strict();
const authenticatedFrameSchema = z.object({
  kind: z.literal("authenticated"),
  protocolVersion: z.literal(SYGSPHERE_COMMS_PROTOCOL_VERSION),
}).strict();
const commandOutcomeSchema = z.object({
  commandId: z.uuid(),
  correlationId: z.uuid(),
  kind: z.literal("command.outcome"),
  outcome: z.string().min(1).max(64),
  protocolVersion: z.literal(SYGSPHERE_COMMS_PROTOCOL_VERSION),
}).strict();
const heartbeatAcknowledgementSchema = z.object({
  connectionEpoch: z.number().int().nonnegative(),
  correlationId: z.uuid(),
  kind: z.literal("heartbeat.ack"),
  protocolVersion: z.literal(SYGSPHERE_COMMS_PROTOCOL_VERSION),
  serverTime: z.iso.datetime(),
}).strict();
const unavailableSnapshotSchema = z.object({
  correlationId: z.uuid(),
  kind: z.literal("snapshot"),
  protocolVersion: z.literal(SYGSPHERE_COMMS_PROTOCOL_VERSION),
  status: z.literal("unavailable"),
}).strict();
const authorizationRefreshSchema = z.object({
  refreshedConnections: z.literal(1),
  requestId: z.uuid(),
}).strict();

type BootstrapPayload = z.infer<typeof bootstrapSchema>;

interface CommunicationsWebSocket {
  readonly readyState: number;
  addEventListener(type: "close", listener: (event: CloseEvent) => void): void;
  addEventListener(type: "error", listener: () => void): void;
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  addEventListener(type: "open", listener: () => void): void;
  close(code?: number, reason?: string): void;
  send(data: string): void;
}

export type SygSphereCommunicationsPeerTransportAdapter = Readonly<{
  closeAll: () => void;
  closeRoom: (roomId: string) => void;
  handleNegotiation: (roomId: string, input: CommunicationsMediaNegotiation) => Promise<void>;
  registerPublication: (roomId: string, kind: CommunicationsPublicationKind, stream: MediaStream) => void;
  removePublication: (roomId: string, kind: Parameters<CommunicationsCoordinatorSession["stopPublication"]>[0]) => Promise<void>;
}>;

export type SygSphereCommunicationsPeerTransportFactory = (input: Readonly<{
  onAnswer: (answer: CommunicationsMediaAnswer) => Promise<void>;
  onReady: (ready: CommunicationsMediaReady) => Promise<void>;
  onRemoteTrack: (track: CommunicationsRemoteTrack) => void;
}>) => SygSphereCommunicationsPeerTransportAdapter;

type SocketBridgeDependencies = Readonly<{
  bootstrap: (accessToken: string, signal: AbortSignal) => Promise<unknown>;
  createPeerTransport: SygSphereCommunicationsPeerTransportFactory;
  createSocket: (url: string) => CommunicationsWebSocket;
  location: () => Readonly<{ origin: string; protocol: string }>;
  now: () => number;
  refreshAuthorization: (accessToken: string, signal: AbortSignal) => Promise<unknown>;
  setTimer: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
}>;

const defaultDependencies: SocketBridgeDependencies = {
  bootstrap: (accessToken, signal) => sygSphereCommunicationsApiRequest<BootstrapPayload>(
    "/api/comms/v1/bootstrap",
    accessToken,
    {
      body: JSON.stringify({ applicationContext: "sygshift", tabInstanceId: crypto.randomUUID() }),
      method: "POST",
      signal,
    },
  ),
  createPeerTransport: (input) => new SygSphereCommunicationsPeerTransport({
    clearTimer: (timer) => clearTimeout(timer),
    createPeer: (configuration) => new RTCPeerConnection(configuration),
    createStream: (tracks) => new MediaStream(tracks),
    now: () => Date.now(),
    ...input,
    setTimer: (callback, delay) => setTimeout(callback, delay),
  }),
  createSocket: (url) => new WebSocket(url),
  location: () => window.location,
  now: () => Date.now(),
  refreshAuthorization: (accessToken, signal) => sygSphereCommunicationsApiRequest<unknown>(
    "/api/comms/v1/authorization/refresh",
    accessToken,
    { body: JSON.stringify({}), method: "POST", signal },
  ),
  setTimer: (callback, delay) => setTimeout(callback, delay),
  clearTimer: (timer) => clearTimeout(timer),
};

export class SygSphereCommunicationsSocketBridge implements CommunicationsCoordinatorBridge {
  private readonly getAccessToken: () => string | null;
  private readonly dependencies: SocketBridgeDependencies;
  private connectionEpoch = 0;

  constructor(
    getAccessToken: () => string | null,
    dependencies: SocketBridgeDependencies = defaultDependencies,
  ) {
    this.getAccessToken = getAccessToken;
    this.dependencies = dependencies;
  }

  async connect({
    accountKey,
    onDisconnect,
    onEvent,
    onRemoteTrack = () => undefined,
  }: Parameters<CommunicationsCoordinatorBridge["connect"]>[0]): Promise<Readonly<{
    authorizationExpiresAt: string | null;
    connectionEpoch: number;
    session: CommunicationsCoordinatorSession;
  }>> {
    if (!accountKey.trim()) throw new Error("Communications require an active account.");
    const accessToken = this.getAccessToken()?.trim();
    if (!accessToken) throw new Error("Your session is no longer valid. Sign in and try again.");

    const bootstrap = bootstrapSchema.parse(await this.dependencies.bootstrap(
      accessToken,
      AbortSignal.timeout(10_000),
    ));
    let ticket: string | null = bootstrap.connection.ticket;
    const expiresAt = Date.parse(bootstrap.connection.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= this.dependencies.now()) {
      ticket = null;
      throw new Error("The communications connection expired. Reopen Communications and try again.");
    }

    const controlUrl = sameOriginSocketUrl(bootstrap.connection.socketPath, this.dependencies.location());
    const socket = this.dependencies.createSocket(controlUrl);
    const connectionEpoch = ++this.connectionEpoch;

    return new Promise((resolve, reject) => {
      let authenticated = false;
      let disposeSession: () => void = () => undefined;
      let handleSessionEvent: (event: SygSphereCommsEvent) => Promise<void> = async () => undefined;
      let intentionalClose = false;
      let settled = false;
      const failOpening = (message: string) => {
        if (settled) return;
        settled = true;
        ticket = null;
        this.dependencies.clearTimer(openingTimer);
        if (socket.readyState < 2) socket.close(1008, "Communications connection unavailable.");
        reject(new Error(message));
      };
      const openingTimer = this.dependencies.setTimer(
        () => failOpening("Communications could not connect in time. Reopen Communications and try again."),
        openingTimeoutMilliseconds,
      );

      socket.addEventListener("open", () => {
        if (!ticket || expiresAt <= this.dependencies.now()) {
          failOpening("The communications connection expired. Reopen Communications and try again.");
          return;
        }
        const firstFrame = JSON.stringify({
          kind: "auth",
          protocolVersion: SYGSPHERE_COMMS_PROTOCOL_VERSION,
          ticket,
        });
        ticket = null;
        socket.send(firstFrame);
      });

      socket.addEventListener("message", (event) => {
        const payload = parseSocketMessage(event.data);
        if (!payload) {
          failOpening("Communications returned an invalid response.");
          if (authenticated) socket.close(1008, "Communications connection unavailable.");
          return;
        }
        if (!authenticated) {
          if (!authenticatedFrameSchema.safeParse(payload).success) {
            failOpening("Communications could not verify this connection.");
            return;
          }
          authenticated = true;
          settled = true;
          this.dependencies.clearTimer(openingTimer);
          const connected = createSession({
            connectionEpoch,
            dependencies: this.dependencies,
            getAccessToken: this.getAccessToken,
            onRemoteTrack,
            socket,
            setIntentionalClose: () => { intentionalClose = true; },
          });
          disposeSession = connected.dispose;
          handleSessionEvent = connected.handleEvent;
          resolve({
            authorizationExpiresAt: null,
            connectionEpoch,
            session: connected.session,
          });
          return;
        }
        if (
          commandOutcomeSchema.safeParse(payload).success
          || heartbeatAcknowledgementSchema.safeParse(payload).success
          || unavailableSnapshotSchema.safeParse(payload).success
        ) return;
        try {
          const communicationsEvent = parseSygSphereCommunicationsEvent(payload);
          void handleSessionEvent(communicationsEvent)
            .then(() => onEvent(communicationsEvent))
            .catch(() => {
              if (socket.readyState < 2) socket.close(1011, "Communications media unavailable.");
            });
        } catch {
          socket.close(1008, "Communications connection unavailable.");
        }
      });

      socket.addEventListener("error", () => {
        if (!authenticated) failOpening("Communications could not open. Reopen Communications and try again.");
      });
      socket.addEventListener("close", (event) => {
        ticket = null;
        this.dependencies.clearTimer(openingTimer);
        disposeSession();
        if (!authenticated) {
          failOpening("Communications could not verify this connection.");
          return;
        }
        if (!intentionalClose) onDisconnect(publicCloseReason(event), isRecoverableClose(event.code));
      });
    });
  }
}

function createSession({
  connectionEpoch,
  dependencies,
  getAccessToken,
  onRemoteTrack,
  setIntentionalClose,
  socket,
}: Readonly<{
  connectionEpoch: number;
  dependencies: Pick<SocketBridgeDependencies, "clearTimer" | "createPeerTransport" | "now" | "refreshAuthorization" | "setTimer">;
  getAccessToken: () => string | null;
  onRemoteTrack: (track: CommunicationsRemoteTrack) => void;
  setIntentionalClose: () => void;
  socket: CommunicationsWebSocket;
}>): Readonly<{
  dispose: () => void;
  handleEvent: (event: SygSphereCommsEvent) => Promise<void>;
  session: CommunicationsCoordinatorSession;
}> {
  let closed = false;
  let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  let authorizationRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  let authorizationRefreshTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  let authorizationRefreshController: AbortController | null = null;
  const requireOpen = () => {
    if (closed || socket.readyState !== 1) throw new Error("Communications are reconnecting.");
  };
  const sendCommand = (input: Parameters<CommunicationsCoordinatorSession["send"]>[0]) => {
    requireOpen();
    const command = parseSygSphereCommsCommand({ ...input, connectionEpoch });
    socket.send(JSON.stringify(command));
  };
  const peerTransport = dependencies.createPeerTransport({
    onAnswer: async (input) => sendCommand({
      commandId: crypto.randomUUID(),
      connectionEpoch,
      kind: "media.answer",
      payload: {
        answer: input.answer,
        generation: input.generation,
        negotiationId: input.negotiationId,
        peerHandle: input.peerHandle,
      },
      protocolVersion: SYGSPHERE_COMMS_PROTOCOL_VERSION,
      roomId: input.roomId,
    }),
    onReady: async (input) => sendCommand({
      commandId: crypto.randomUUID(),
      connectionEpoch,
      kind: "media.ready",
      payload: {
        callId: input.callId,
        generation: input.generation,
        inputKind: input.inputKind,
        negotiationId: input.negotiationId,
        peerHandle: input.peerHandle,
      },
      protocolVersion: SYGSPHERE_COMMS_PROTOCOL_VERSION,
      roomId: input.roomId,
    }),
    onRemoteTrack,
  });
  const dispose = () => {
    closed = true;
    if (heartbeatTimer) dependencies.clearTimer(heartbeatTimer);
    if (authorizationRefreshTimer) dependencies.clearTimer(authorizationRefreshTimer);
    if (authorizationRefreshTimeoutTimer) dependencies.clearTimer(authorizationRefreshTimeoutTimer);
    authorizationRefreshController?.abort("communications_session_ended");
    peerTransport.closeAll();
    heartbeatTimer = null;
    authorizationRefreshTimer = null;
    authorizationRefreshTimeoutTimer = null;
    authorizationRefreshController = null;
  };
  const scheduleHeartbeat = () => {
    if (closed) return;
    heartbeatTimer = dependencies.setTimer(() => {
      heartbeatTimer = null;
      try {
        sendCommand(systemCommand("heartbeat", connectionEpoch));
        scheduleHeartbeat();
      } catch {
        dispose();
        if (socket.readyState < 2) socket.close(1011, "Communications connection unavailable.");
      }
    }, heartbeatMilliseconds);
  };
  const scheduleAuthorizationRefresh = () => {
    if (closed) return;
    authorizationRefreshTimer = dependencies.setTimer(() => {
      authorizationRefreshTimer = null;
      const accessToken = getAccessToken()?.trim();
      if (!accessToken) {
        dispose();
        if (socket.readyState < 2) socket.close(1008, "Communications authorization expired.");
        return;
      }
      const refreshController = new AbortController();
      authorizationRefreshController = refreshController;
      authorizationRefreshTimeoutTimer = dependencies.setTimer(
        () => refreshController.abort("communications_authorization_timeout"),
        10_000,
      );
      void dependencies.refreshAuthorization(accessToken, refreshController.signal)
        .then((payload) => authorizationRefreshSchema.parse(payload))
        .then(() => scheduleAuthorizationRefresh())
        .catch(() => {
          if (closed) return;
          dispose();
          if (socket.readyState < 2) socket.close(1008, "Communications authorization expired.");
        })
        .finally(() => {
          if (authorizationRefreshController !== refreshController) return;
          if (authorizationRefreshTimeoutTimer) dependencies.clearTimer(authorizationRefreshTimeoutTimer);
          authorizationRefreshController = null;
          authorizationRefreshTimeoutTimer = null;
        });
    }, authorizationRefreshMilliseconds);
  };
  const session: CommunicationsCoordinatorSession = {
    close(reason) {
      if (closed) return;
      setIntentionalClose();
      dispose();
      socket.close(1000, reason.slice(0, 120));
    },
    async publish(input) {
      requireOpen();
      peerTransport.registerPublication(input.roomId, input.kind, input.stream);
    },
    async send(input) {
      sendCommand(input);
    },
    async stopPublication(kind, roomId) {
      if (closed) return;
      requireOpen();
      if (roomId) await peerTransport.removePublication(roomId, kind);
    },
  };
  const handleEvent = async (event: SygSphereCommsEvent) => {
    if (event.kind === "media.negotiation") {
      const payload = SYGSPHERE_COMMS_EVENT_PAYLOAD_SCHEMAS["media.negotiation"].parse(event.payload);
      await peerTransport.handleNegotiation(event.roomId, payload);
      return;
    }
    if (["media.closed", "media.failed", "call.ended", "call.missed", "meeting.ended", "session.revoked"].includes(event.kind)) {
      peerTransport.closeRoom(event.roomId);
    }
  };
  sendCommand(systemCommand("snapshot.request", connectionEpoch));
  scheduleHeartbeat();
  scheduleAuthorizationRefresh();
  return { dispose, handleEvent, session };
}

function systemCommand(kind: "heartbeat" | "snapshot.request", connectionEpoch: number) {
  return {
    commandId: crypto.randomUUID(),
    connectionEpoch,
    kind,
    payload: {},
    protocolVersion: SYGSPHERE_COMMS_PROTOCOL_VERSION,
  } as const;
}

function sameOriginSocketUrl(path: string, location: Readonly<{ origin: string; protocol: string }>): string {
  if (path !== socketPath || !location.origin || !["http:", "https:"].includes(location.protocol)) {
    throw new Error("Communications returned an invalid connection address.");
  }
  const url = new URL(path, location.origin);
  if (url.origin !== location.origin || url.pathname !== socketPath || url.search || url.hash) {
    throw new Error("Communications returned an invalid connection address.");
  }
  url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function parseSocketMessage(value: unknown): unknown | null {
  if (typeof value !== "string" || new TextEncoder().encode(value).byteLength > 128 * 1024) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function publicCloseReason(event: CloseEvent): string {
  if (event.code === 1008) return "Communications authorization changed. Reopen Communications and try again.";
  return "Communications disconnected. Reconnecting requires a fresh secure connection.";
}

function isRecoverableClose(code: number): boolean {
  return ![1008, 4401, 4403].includes(code);
}
