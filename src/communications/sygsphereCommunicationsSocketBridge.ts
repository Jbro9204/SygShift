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
const commandResponseSchema = z.object({
  outcome: z.enum([
    "accepted",
    "invalid_state",
    "recipient_unavailable",
    "rate_limited",
    "runtime_disabled",
    "provider_unavailable",
  ]),
  requestId: z.uuid(),
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
const pttPreparationSchema = z.object({
  iceServers: z.array(z.object({
    credential: z.string().min(1).max(512).optional(),
    urls: z.union([z.string().min(1).max(256), z.array(z.string().min(1).max(256)).min(1).max(8)]),
    username: z.string().min(1).max(256).optional(),
  }).strict()).min(1).max(4),
  requestId: z.uuid(),
}).strict();
const directCallContextSchema = z.object({
  conversationReference: z.uuid(),
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
  acknowledgePttListenerReady: (accessToken: string, input: unknown, signal: AbortSignal) => Promise<unknown>;
  bootstrap: (accessToken: string, signal: AbortSignal) => Promise<unknown>;
  createPeerTransport: SygSphereCommunicationsPeerTransportFactory;
  createSocket: (url: string) => CommunicationsWebSocket;
  getDirectCallContext: (accessToken: string, callId: string, signal: AbortSignal) => Promise<unknown>;
  location: () => Readonly<{ origin: string; protocol: string }>;
  now: () => number;
  prepareDirectAudio: (accessToken: string, input: unknown, signal: AbortSignal) => Promise<unknown>;
  prepareMeetingMedia: (accessToken: string, meetingId: string, input: unknown, signal: AbortSignal) => Promise<unknown>;
  preparePtt: (accessToken: string, input: unknown, signal: AbortSignal) => Promise<unknown>;
  refreshAuthorization: (accessToken: string, signal: AbortSignal) => Promise<unknown>;
  sendCommand: (accessToken: string, command: unknown, signal: AbortSignal) => Promise<unknown>;
  startPtt: (accessToken: string, input: unknown, signal: AbortSignal) => Promise<unknown>;
  startDirectAudio: (accessToken: string, input: unknown, signal: AbortSignal) => Promise<unknown>;
  startMeetingMedia: (accessToken: string, meetingId: string, operation: "publish" | "subscribe", input: unknown, signal: AbortSignal) => Promise<unknown>;
  stopMeetingMedia: (accessToken: string, meetingId: string, input: unknown, signal: AbortSignal) => Promise<unknown>;
  createRtcPeer: (configuration: RTCConfiguration) => RTCPeerConnection;
  createStream: (tracks: MediaStreamTrack[]) => MediaStream;
  setTimer: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
}>;

const defaultDependencies: SocketBridgeDependencies = {
  acknowledgePttListenerReady: (accessToken, input, signal) => sygSphereCommunicationsApiRequest<unknown>(
    "/api/comms/v1/ptt/listener-ready",
    accessToken,
    { body: JSON.stringify(input), headers: { "content-type": "application/json" }, method: "POST", signal },
  ),
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
  createRtcPeer: (configuration) => new RTCPeerConnection(configuration),
  createStream: (tracks) => new MediaStream(tracks),
  createSocket: (url) => new WebSocket(url),
  getDirectCallContext: (accessToken, callId, signal) => sygSphereCommunicationsApiRequest<unknown>(
    `/api/comms/v1/calls/${encodeURIComponent(callId)}`,
    accessToken,
    { signal },
  ),
  location: () => window.location,
  now: () => Date.now(),
  prepareDirectAudio: (accessToken, input, signal) => sygSphereCommunicationsApiRequest<unknown>(
    "/api/comms/v1/media/prepare",
    accessToken,
    { body: JSON.stringify(input), headers: { "content-type": "application/json" }, method: "POST", signal },
  ),
  prepareMeetingMedia: (accessToken, meetingId, input, signal) => sygSphereCommunicationsApiRequest<unknown>(
    `/api/comms/v1/meetings/${encodeURIComponent(meetingId)}/media/prepare`,
    accessToken,
    { body: JSON.stringify(input), headers: { "content-type": "application/json" }, method: "POST", signal },
  ),
  preparePtt: (accessToken, input, signal) => sygSphereCommunicationsApiRequest<unknown>(
    "/api/comms/v1/ptt/prepare",
    accessToken,
    { body: JSON.stringify(input), headers: { "content-type": "application/json" }, method: "POST", signal },
  ),
  refreshAuthorization: (accessToken, signal) => sygSphereCommunicationsApiRequest<unknown>(
    "/api/comms/v1/authorization/refresh",
    accessToken,
    { body: JSON.stringify({}), method: "POST", signal },
  ),
  sendCommand: (accessToken, command, signal) => sygSphereCommunicationsApiRequest<unknown>(
    "/api/comms/v1/commands",
    accessToken,
    {
      body: JSON.stringify({ command }),
      headers: { "content-type": "application/json" },
      method: "POST",
      signal,
    },
  ),
  startPtt: (accessToken, input, signal) => sygSphereCommunicationsApiRequest<unknown>(
    input && typeof input === "object" && "mode" in input && (input as { mode?: unknown }).mode === "listener"
      ? "/api/comms/v1/ptt/listen"
      : "/api/comms/v1/ptt/audio",
    accessToken,
    {
      body: JSON.stringify(input),
      headers: { "content-type": "application/json" },
      method: "POST",
      signal,
    },
  ),
  startDirectAudio: (accessToken, input, signal) => sygSphereCommunicationsApiRequest<unknown>(
    "/api/comms/v1/media/direct-audio",
    accessToken,
    { body: JSON.stringify(input), headers: { "content-type": "application/json" }, method: "POST", signal },
  ),
  startMeetingMedia: (accessToken, meetingId, operation, input, signal) => sygSphereCommunicationsApiRequest<unknown>(
    `/api/comms/v1/meetings/${encodeURIComponent(meetingId)}/media/${operation}`,
    accessToken,
    { body: JSON.stringify(input), headers: { "content-type": "application/json" }, method: "POST", signal },
  ),
  stopMeetingMedia: (accessToken, meetingId, input, signal) => sygSphereCommunicationsApiRequest<unknown>(
    `/api/comms/v1/meetings/${encodeURIComponent(meetingId)}/media/stop`,
    accessToken,
    { body: JSON.stringify(input), headers: { "content-type": "application/json" }, method: "POST", signal },
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

type PttPeerState = Readonly<{
  peer: RTCPeerConnection;
  publication: "listener" | "publisher";
  roomId: string;
  transmissionRequestId: string;
}>;

type MeetingMediaKind = "audio" | "screen" | "video";
type MeetingPeerState = Readonly<{
  mediaKind: MeetingMediaKind;
  meetingId: string;
  peer: RTCPeerConnection;
  role: "listener" | "publisher";
  roomId: string;
  sourceConnectionId: string;
}>;

function createSession({
  connectionEpoch,
  dependencies,
  getAccessToken,
  onRemoteTrack,
  setIntentionalClose,
  socket,
}: Readonly<{
  connectionEpoch: number;
  dependencies: Pick<SocketBridgeDependencies, "acknowledgePttListenerReady" | "clearTimer" | "createPeerTransport" | "createRtcPeer" | "createStream" | "getDirectCallContext" | "now" | "prepareDirectAudio" | "prepareMeetingMedia" | "preparePtt" | "refreshAuthorization" | "sendCommand" | "setTimer" | "startDirectAudio" | "startMeetingMedia" | "startPtt" | "stopMeetingMedia">;
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
  const pttPeers = new Map<string, PttPeerState>();
  const directPeers = new Map<string, RTCPeerConnection>();
  const meetingPeers = new Map<string, MeetingPeerState>();
  const requireOpen = () => {
    if (closed || socket.readyState !== 1) throw new Error("Communications are reconnecting.");
  };
  const sendSocketControlFrame = (input: Parameters<CommunicationsCoordinatorSession["send"]>[0]) => {
    requireOpen();
    const command = parseSygSphereCommsCommand({ ...input, connectionEpoch });
    socket.send(JSON.stringify(command));
  };
  const sendCommand = async (input: Parameters<CommunicationsCoordinatorSession["send"]>[0]) => {
    requireOpen();
    const command = parseSygSphereCommsCommand({ ...input, connectionEpoch });
    if (command.kind === "heartbeat" || command.kind === "snapshot.request") {
      socket.send(JSON.stringify(command));
      return;
    }
    const accessToken = getAccessToken()?.trim();
    if (!accessToken) throw new Error("Your session is no longer valid. Sign in and try again.");
    const response = commandResponseSchema.parse(await dependencies.sendCommand(
      accessToken,
      command,
      AbortSignal.timeout(10_000),
    ));
    if (response.outcome !== "accepted") {
      throw new Error(commandOutcomeMessage(response.outcome));
    }
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
  const closePttPeer = (transmissionRequestId: string) => {
    const current = pttPeers.get(transmissionRequestId);
    if (!current) return;
    current.peer.close();
    pttPeers.delete(transmissionRequestId);
  };
  const closeDirectPeer = (callId: string) => {
    const peer = directPeers.get(callId);
    if (!peer) return;
    peer.close();
    directPeers.delete(callId);
  };
  const meetingPeerKey = (meetingId: string, role: MeetingPeerState["role"], sourceConnectionId: string, mediaKind: MeetingMediaKind) =>
    `${meetingId}:${role}:${sourceConnectionId}:${mediaKind}`;
  const closeMeetingPeers = (predicate: (peer: MeetingPeerState) => boolean) => {
    for (const [key, peer] of meetingPeers) {
      if (!predicate(peer)) continue;
      peer.peer.close();
      meetingPeers.delete(key);
    }
  };
  const meetingPublicationKind = (mediaKind: MeetingMediaKind): CommunicationsPublicationKind =>
    mediaKind === "audio" ? "call_audio" : mediaKind === "video" ? "camera" : "screen";
  const meetingMediaKind = (kind: CommunicationsPublicationKind): MeetingMediaKind | null =>
    kind === "call_audio" ? "audio" : kind === "camera" ? "video" : kind === "screen" ? "screen" : null;
  const startMeetingPublisher = async (input: Readonly<{
    mediaKind: MeetingMediaKind;
    meetingId: string;
    roomId: string;
    stream: MediaStream;
  }>) => {
    const accessToken = getAccessToken()?.trim();
    if (!accessToken) throw new Error("Your session is no longer valid. Sign in and try again.");
    const key = meetingPeerKey(input.meetingId, "publisher", "self", input.mediaKind);
    const prior = meetingPeers.get(key);
    prior?.peer.close();
    meetingPeers.delete(key);
    const preparation = pttPreparationSchema.parse(await dependencies.prepareMeetingMedia(
      accessToken,
      input.meetingId,
      { mediaKind: input.mediaKind },
      AbortSignal.timeout(10_000),
    ));
    const peer = dependencies.createRtcPeer({ iceServers: preparation.iceServers });
    const tracks = input.mediaKind === "audio" ? input.stream.getAudioTracks() : input.stream.getVideoTracks();
    for (const track of tracks) peer.addTrack(track, input.stream);
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    await waitForPeerIce(peer, dependencies);
    const localDescription = peer.localDescription;
    if (!localDescription?.sdp || localDescription.type !== "offer") {
      peer.close();
      throw new Error("Communications could not prepare meeting media.");
    }
    meetingPeers.set(key, { mediaKind: input.mediaKind, meetingId: input.meetingId, peer, role: "publisher", roomId: input.roomId, sourceConnectionId: "self" });
    try {
      const response = commandResponseSchema.parse(await dependencies.startMeetingMedia(
        accessToken,
        input.meetingId,
        "publish",
        { mediaKind: input.mediaKind, offer: localDescription.sdp },
        AbortSignal.timeout(10_000),
      ));
      if (response.outcome !== "accepted") throw new Error(commandOutcomeMessage(response.outcome));
    } catch (error) {
      closeMeetingPeers((item) => item.meetingId === input.meetingId && item.role === "publisher" && item.mediaKind === input.mediaKind);
      throw error;
    }
  };
  const startMeetingListener = async (input: Readonly<{
    mediaKind: MeetingMediaKind;
    meetingId: string;
    roomId: string;
    sourceConnectionId: string;
  }>) => {
    const key = meetingPeerKey(input.meetingId, "listener", input.sourceConnectionId, input.mediaKind);
    if (meetingPeers.has(key) || closed || socket.readyState !== 1) return;
    const accessToken = getAccessToken()?.trim();
    if (!accessToken) return;
    try {
      const preparation = pttPreparationSchema.parse(await dependencies.prepareMeetingMedia(
        accessToken,
        input.meetingId,
        { mediaKind: input.mediaKind, sourceConnectionId: input.sourceConnectionId },
        AbortSignal.timeout(10_000),
      ));
      const peer = dependencies.createRtcPeer({ iceServers: preparation.iceServers });
      peer.addTransceiver(input.mediaKind === "audio" ? "audio" : "video", { direction: "recvonly" });
      peer.addEventListener("track", (trackEvent) => {
        const stream = trackEvent.streams[0] ?? dependencies.createStream([trackEvent.track]);
        onRemoteTrack({
          callId: input.meetingId,
          mediaKind: input.mediaKind === "audio" ? "audio" : "video",
          participantConnectionId: input.sourceConnectionId,
          publicationKind: meetingPublicationKind(input.mediaKind),
          roomId: input.roomId,
          stream,
          trackReference: `meeting:${input.meetingId}:${input.sourceConnectionId}:${input.mediaKind}`,
        });
      });
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      await waitForPeerIce(peer, dependencies);
      const localDescription = peer.localDescription;
      if (!localDescription?.sdp || localDescription.type !== "offer") {
        peer.close();
        return;
      }
      meetingPeers.set(key, { mediaKind: input.mediaKind, meetingId: input.meetingId, peer, role: "listener", roomId: input.roomId, sourceConnectionId: input.sourceConnectionId });
      const response = commandResponseSchema.parse(await dependencies.startMeetingMedia(
        accessToken,
        input.meetingId,
        "subscribe",
        { mediaKind: input.mediaKind, offer: localDescription.sdp, sourceConnectionId: input.sourceConnectionId },
        AbortSignal.timeout(10_000),
      ));
      if (response.outcome !== "accepted") closeMeetingPeers((item) => item.meetingId === input.meetingId && item.role === "listener" && item.sourceConnectionId === input.sourceConnectionId && item.mediaKind === input.mediaKind);
    } catch {
      closeMeetingPeers((item) => item.meetingId === input.meetingId && item.role === "listener" && item.sourceConnectionId === input.sourceConnectionId && item.mediaKind === input.mediaKind);
    }
  };
  const stopMeetingPublisher = async (meetingId: string, mediaKind: MeetingMediaKind) => {
    closeMeetingPeers((item) => item.meetingId === meetingId && item.role === "publisher" && item.mediaKind === mediaKind);
    const accessToken = getAccessToken()?.trim();
    if (!accessToken) return;
    const response = commandResponseSchema.parse(await dependencies.stopMeetingMedia(
      accessToken,
      meetingId,
      { mediaKind },
      AbortSignal.timeout(10_000),
    ));
    if (response.outcome !== "accepted") throw new Error(commandOutcomeMessage(response.outcome));
  };
  const startDirectCallAudio = async (input: Readonly<{ callId: string; stream: MediaStream }>) => {
    const accessToken = getAccessToken()?.trim();
    if (!accessToken) throw new Error("Your session is no longer valid. Sign in and try again.");
    closeDirectPeer(input.callId);
    const context = directCallContextSchema.parse(await dependencies.getDirectCallContext(
      accessToken,
      input.callId,
      AbortSignal.timeout(10_000),
    ));
    const preparation = pttPreparationSchema.parse(await dependencies.prepareDirectAudio(
      accessToken,
      { callId: input.callId, conversationReference: context.conversationReference },
      AbortSignal.timeout(10_000),
    ));
    const peer = dependencies.createRtcPeer({ iceServers: preparation.iceServers });
    for (const track of input.stream.getAudioTracks()) peer.addTrack(track, input.stream);
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    await waitForPeerIce(peer, dependencies);
    const localDescription = peer.localDescription;
    if (!localDescription?.sdp || localDescription.type !== "offer") {
      peer.close();
      throw new Error("Communications could not prepare direct-call audio.");
    }
    directPeers.set(input.callId, peer);
    try {
      const response = commandResponseSchema.parse(await dependencies.startDirectAudio(
        accessToken,
        { callId: input.callId, conversationReference: context.conversationReference, offer: localDescription.sdp },
        AbortSignal.timeout(10_000),
      ));
      if (response.outcome !== "accepted") throw new Error(commandOutcomeMessage(response.outcome));
    } catch (error) {
      closeDirectPeer(input.callId);
      throw error;
    }
  };
  const startPttPublisher = async (input: Readonly<{
    channelReference: string;
    roomId: string;
    stream: MediaStream;
    transmissionRequestId: string;
  }>) => {
    const accessToken = getAccessToken()?.trim();
    if (!accessToken) throw new Error("Your session is no longer valid. Sign in and try again.");
    closePttPeer(input.transmissionRequestId);
    const preparation = pttPreparationSchema.parse(await dependencies.preparePtt(
      accessToken,
      { channelReference: input.channelReference, mode: "publisher", transmissionRequestId: input.transmissionRequestId },
      AbortSignal.timeout(10_000),
    ));
    const peer = dependencies.createRtcPeer({ iceServers: preparation.iceServers });
    for (const track of input.stream.getAudioTracks()) peer.addTrack(track, input.stream);
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    await waitForPeerIce(peer, dependencies);
    const localDescription = peer.localDescription;
    if (!localDescription?.sdp || localDescription.type !== "offer") {
      peer.close();
      throw new Error("Communications could not prepare push-to-talk audio.");
    }
    pttPeers.set(input.transmissionRequestId, {
      peer,
      publication: "publisher",
      roomId: input.roomId,
      transmissionRequestId: input.transmissionRequestId,
    });
    try {
      const response = commandResponseSchema.parse(await dependencies.startPtt(
        accessToken,
        {
          channelReference: input.channelReference,
          offer: localDescription.sdp,
          transmissionRequestId: input.transmissionRequestId,
        },
        AbortSignal.timeout(10_000),
      ));
      if (response.outcome !== "accepted") throw new Error(commandOutcomeMessage(response.outcome));
    } catch (error) {
      closePttPeer(input.transmissionRequestId);
      throw error;
    }
  };
  const startPttListener = async (transmissionRequestId: string, roomId: string) => {
    if (pttPeers.has(transmissionRequestId)) return;
    const accessToken = getAccessToken()?.trim();
    if (!accessToken || closed || socket.readyState !== 1) return;
    const preparation = pttPreparationSchema.parse(await dependencies.preparePtt(
      accessToken,
      { mode: "listener", transmissionRequestId },
      AbortSignal.timeout(10_000),
    ));
    const peer = dependencies.createRtcPeer({ iceServers: preparation.iceServers });
    peer.addTransceiver("audio", { direction: "recvonly" });
    peer.addEventListener("track", (trackEvent) => {
      const stream = trackEvent.streams[0] ?? dependencies.createStream([trackEvent.track]);
      onRemoteTrack({
        callId: transmissionRequestId,
        mediaKind: "audio",
        participantConnectionId: null,
        publicationKind: "ptt",
        roomId,
        stream,
        trackReference: `ptt:${transmissionRequestId}:audio`,
      });
    });
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    await waitForPeerIce(peer, dependencies);
    const localDescription = peer.localDescription;
    if (!localDescription?.sdp || localDescription.type !== "offer") {
      peer.close();
      return;
    }
    pttPeers.set(transmissionRequestId, { peer, publication: "listener", roomId, transmissionRequestId });
    try {
      const response = commandResponseSchema.parse(await dependencies.startPtt(
        accessToken,
        { mode: "listener", offer: localDescription.sdp, transmissionRequestId },
        AbortSignal.timeout(10_000),
      ));
      if (response.outcome !== "accepted") closePttPeer(transmissionRequestId);
    } catch {
      closePttPeer(transmissionRequestId);
    }
  };
  const dispose = () => {
    closed = true;
    if (heartbeatTimer) dependencies.clearTimer(heartbeatTimer);
    if (authorizationRefreshTimer) dependencies.clearTimer(authorizationRefreshTimer);
    if (authorizationRefreshTimeoutTimer) dependencies.clearTimer(authorizationRefreshTimeoutTimer);
    authorizationRefreshController?.abort("communications_session_ended");
    peerTransport.closeAll();
    for (const transmissionRequestId of [...pttPeers.keys()]) closePttPeer(transmissionRequestId);
    for (const callId of [...directPeers.keys()]) closeDirectPeer(callId);
    closeMeetingPeers(() => true);
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
        sendSocketControlFrame(systemCommand("heartbeat", connectionEpoch));
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
      if (input.kind === "ptt") {
        if (!input.channelReference || !input.transmissionRequestId) {
          throw new Error("Push-to-talk could not verify its authorized channel.");
        }
        await startPttPublisher({
          channelReference: input.channelReference,
          roomId: input.roomId,
          stream: input.stream,
          transmissionRequestId: input.transmissionRequestId,
        });
        return;
      }
      if (input.kind === "call_audio" && input.roomId.startsWith("call:")) {
        await startDirectCallAudio({ callId: input.roomId.slice("call:".length), stream: input.stream });
        return;
      }
      if (input.roomId.startsWith("meeting:")) {
        const mediaKind = meetingMediaKind(input.kind);
        if (!mediaKind) throw new Error("That meeting publication is not available.");
        await startMeetingPublisher({
          mediaKind,
          meetingId: input.roomId.slice("meeting:".length),
          roomId: input.roomId,
          stream: input.stream,
        });
        return;
      }
      peerTransport.registerPublication(input.roomId, input.kind, input.stream);
    },
    async send(input) {
      await sendCommand(input);
    },
    async stopPublication(kind, roomId) {
      if (closed) return;
      requireOpen();
      if (kind === "ptt" && roomId?.startsWith("ptt:")) {
        closePttPeer(roomId.slice("ptt:".length));
        return;
      }
      if (kind === "call_audio" && roomId?.startsWith("call:")) {
        closeDirectPeer(roomId.slice("call:".length));
        return;
      }
      if (roomId?.startsWith("meeting:")) {
        const mediaKind = meetingMediaKind(kind);
        if (mediaKind) await stopMeetingPublisher(roomId.slice("meeting:".length), mediaKind).catch(() => undefined);
        return;
      }
      if (roomId) await peerTransport.removePublication(roomId, kind);
    },
  };
  const handleEvent = async (event: SygSphereCommsEvent) => {
    if (event.kind === "media.negotiation") {
      const payload = SYGSPHERE_COMMS_EVENT_PAYLOAD_SCHEMAS["media.negotiation"].parse(event.payload);
      const pttPeer = pttPeers.get(payload.callId);
      if (pttPeer && pttPeer.roomId === event.roomId && payload.descriptionType === "answer") {
        await pttPeer.peer.setRemoteDescription({ sdp: payload.description, type: "answer" });
        if (pttPeer.publication === "listener") {
          const accessToken = getAccessToken()?.trim();
          if (!accessToken) {
            closePttPeer(payload.callId);
            return;
          }
          const response = commandResponseSchema.parse(await dependencies.acknowledgePttListenerReady(
            accessToken,
            { transmissionRequestId: payload.callId },
            AbortSignal.timeout(10_000),
          ));
          if (response.outcome !== "accepted") closePttPeer(payload.callId);
        }
        return;
      }
      const directPeer = directPeers.get(payload.callId);
      if (directPeer && event.roomId === `call:${payload.callId}` && payload.descriptionType === "answer" && payload.direction === "publish") {
        await directPeer.setRemoteDescription({ sdp: payload.description, type: "answer" });
        return;
      }
      if (event.roomId === `meeting:${payload.callId}` && payload.descriptionType === "answer") {
        const binding = payload.trackBindings[0];
        const mediaKind = binding?.publicationKind === "call_audio"
          ? "audio"
          : binding?.publicationKind === "camera"
            ? "video"
            : binding?.publicationKind === "screen"
              ? "screen"
              : null;
        if (mediaKind) {
          const meetingPeer = payload.direction === "subscribe" && binding?.participantConnectionId
            ? meetingPeers.get(meetingPeerKey(payload.callId, "listener", binding.participantConnectionId, mediaKind))
            : [...meetingPeers.values()].find((item) => item.meetingId === payload.callId && item.role === "publisher" && item.mediaKind === mediaKind);
          if (meetingPeer) {
            await meetingPeer.peer.setRemoteDescription({ sdp: payload.description, type: "answer" });
            return;
          }
        }
      }
      await peerTransport.handleNegotiation(event.roomId, payload);
      return;
    }
    if (event.kind === "transmission.started") {
      const payload = SYGSPHERE_COMMS_EVENT_PAYLOAD_SCHEMAS["transmission.started"].parse(event.payload);
      void startPttListener(payload.transmissionRequestId, event.roomId).catch(() => undefined);
      return;
    }
    if (event.kind === "media.source.available" && event.roomId.startsWith("meeting:")) {
      const payload = SYGSPHERE_COMMS_EVENT_PAYLOAD_SCHEMAS["media.source.available"].parse(event.payload);
      void startMeetingListener({
        mediaKind: payload.mediaKind,
        meetingId: payload.callId,
        roomId: event.roomId,
        sourceConnectionId: payload.participantConnectionId,
      });
      return;
    }
    if (event.kind === "media.source.unavailable" && event.roomId.startsWith("meeting:")) {
      const payload = SYGSPHERE_COMMS_EVENT_PAYLOAD_SCHEMAS["media.source.unavailable"].parse(event.payload);
      closeMeetingPeers((item) => item.meetingId === payload.callId
        && item.role === "listener"
        && item.sourceConnectionId === payload.participantConnectionId
        && item.mediaKind === payload.mediaKind);
      return;
    }
    if (["transmission.ended", "floor.revoked", "media.closed"].includes(event.kind) && event.roomId.startsWith("ptt:")) {
      closePttPeer(event.roomId.slice("ptt:".length));
    }
    if (["call.ended", "call.missed", "media.closed"].includes(event.kind) && event.roomId.startsWith("call:")) {
      closeDirectPeer(event.roomId.slice("call:".length));
    }
    if (event.roomId.startsWith("meeting:")) {
      const meetingId = event.roomId.slice("meeting:".length);
      if (["meeting.ended", "media.closed"].includes(event.kind)) closeMeetingPeers((item) => item.meetingId === meetingId);
      const eventPayload = event.payload as Record<string, unknown>;
      if (event.kind === "participant.removed" || (event.kind === "participant.changed" && eventPayload.state === "left")) {
        const participantConnectionId = typeof eventPayload.participantConnectionId === "string" ? eventPayload.participantConnectionId : null;
        if (participantConnectionId) closeMeetingPeers((item) => item.meetingId === meetingId && item.sourceConnectionId === participantConnectionId);
      }
    }
    if (["media.closed", "media.failed", "call.ended", "call.missed", "meeting.ended", "session.revoked"].includes(event.kind)) {
      peerTransport.closeRoom(event.roomId);
    }
  };
  sendSocketControlFrame(systemCommand("snapshot.request", connectionEpoch));
  scheduleHeartbeat();
  scheduleAuthorizationRefresh();
  return { dispose, handleEvent, session };
}

function commandOutcomeMessage(outcome: string): string {
  if (outcome === "recipient_unavailable") return "That person is not available for Communications right now.";
  if (outcome === "rate_limited") return "Please wait a moment before trying Communications again.";
  if (outcome === "runtime_disabled" || outcome === "provider_unavailable") {
    return "Communications is temporarily unavailable. Use messages or Dispatch and try again.";
  }
  return "Communications could not complete that action. Reopen Communications and try again.";
}

function waitForPeerIce(
  peer: RTCPeerConnection,
  dependencies: Pick<SocketBridgeDependencies, "clearTimer" | "setTimer">,
): Promise<void> {
  if (peer.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const complete = () => {
      if (peer.iceGatheringState !== "complete") return;
      dependencies.clearTimer(timer);
      peer.removeEventListener("icegatheringstatechange", complete);
      resolve();
    };
    const timer = dependencies.setTimer(() => {
      peer.removeEventListener("icegatheringstatechange", complete);
      reject(new Error("Communications could not prepare push-to-talk audio in time."));
    }, 5_000);
    peer.addEventListener("icegatheringstatechange", complete);
  });
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
