import type { z } from "zod";
import { SYGSPHERE_COMMS_EVENT_PAYLOAD_SCHEMAS } from "../../shared/sygsphere-communications/v1/contract";
import type { CommunicationsPublicationKind } from "./sygsphereCommunicationsController";

export type CommunicationsMediaNegotiation = z.infer<
  (typeof SYGSPHERE_COMMS_EVENT_PAYLOAD_SCHEMAS)["media.negotiation"]
>;

export type CommunicationsRemoteTrack = Readonly<{
  callId: string;
  mediaKind: "audio" | "video" | "screen";
  participantConnectionId: string | null;
  publicationKind: CommunicationsPublicationKind;
  roomId: string;
  stream: MediaStream;
  trackReference: string;
}>;

export type CommunicationsMediaAnswer = Readonly<{
  answer: string;
  generation: number;
  negotiationId: string;
  peerHandle: string;
  roomId: string;
}>;

export type CommunicationsMediaReady = Readonly<{
  callId: string;
  generation: number;
  inputKind: "audio" | "video";
  negotiationId: string;
  peerHandle: string;
  roomId: string;
}>;

type Timer = ReturnType<typeof setTimeout>;
type PeerState = {
  callId: string;
  generation: number;
  negotiationId: string;
  observedRemoteMids: Set<string>;
  peer: RTCPeerConnection;
  readyKinds: Set<"audio" | "video">;
  roomId: string;
  trackBindings: Map<string, CommunicationsMediaNegotiation["trackBindings"][number]>;
};

type PeerTransportDependencies = Readonly<{
  clearTimer: (timer: Timer) => void;
  createPeer: (configuration: RTCConfiguration) => RTCPeerConnection;
  createStream: (tracks: MediaStreamTrack[]) => MediaStream;
  now: () => number;
  onAnswer: (input: CommunicationsMediaAnswer) => Promise<void>;
  onReady: (input: CommunicationsMediaReady) => Promise<void>;
  onRemoteTrack: (track: CommunicationsRemoteTrack) => void;
  setTimer: (callback: () => void, delay: number) => Timer;
}>;

const iceGatheringTimeoutMilliseconds = 10_000;

const defaultDependencies: PeerTransportDependencies = {
  clearTimer: (timer) => clearTimeout(timer),
  createPeer: (configuration) => new RTCPeerConnection(configuration),
  createStream: (tracks) => new MediaStream(tracks),
  now: () => Date.now(),
  onAnswer: async () => undefined,
  onReady: async () => undefined,
  onRemoteTrack: () => undefined,
  setTimer: (callback, delay) => setTimeout(callback, delay),
};

export class SygSphereCommunicationsPeerTransport {
  private readonly dependencies: PeerTransportDependencies;
  private readonly peers = new Map<string, PeerState>();
  private readonly publications = new Map<string, MediaStream>();
  private readonly queues = new Map<string, Promise<void>>();

  constructor(dependencies: PeerTransportDependencies = defaultDependencies) {
    this.dependencies = dependencies;
  }

  registerPublication(roomId: string, kind: CommunicationsPublicationKind, stream: MediaStream): void {
    this.publications.set(publicationKey(roomId, kind), stream);
  }

  async removePublication(roomId: string, kind: CommunicationsPublicationKind): Promise<void> {
    this.publications.delete(publicationKey(roomId, kind));
    const removals: Promise<void>[] = [];
    for (const state of this.peers.values()) {
      if (state.roomId !== roomId) continue;
      for (const [mid, binding] of state.trackBindings) {
        if (binding.role !== "local" || binding.publicationKind !== kind) continue;
        const sender = state.peer.getTransceivers().find((item) => item.mid === mid)?.sender;
        if (sender) removals.push(sender.replaceTrack(null));
      }
    }
    await Promise.all(removals);
  }

  handleNegotiation(roomId: string, input: CommunicationsMediaNegotiation): Promise<void> {
    const previous = this.queues.get(input.peerHandle) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.applyNegotiation(roomId, input));
    this.queues.set(input.peerHandle, next);
    return next.finally(() => {
      if (this.queues.get(input.peerHandle) === next) this.queues.delete(input.peerHandle);
    });
  }

  closePeer(peerHandle: string): void {
    const current = this.peers.get(peerHandle);
    if (!current) return;
    current.peer.close();
    this.peers.delete(peerHandle);
    this.queues.delete(peerHandle);
  }

  closeRoom(roomId: string): void {
    for (const [peerHandle, state] of this.peers) {
      if (state.roomId === roomId) this.closePeer(peerHandle);
    }
    for (const key of this.publications.keys()) {
      if (key.startsWith(`${roomId}:`)) this.publications.delete(key);
    }
  }

  closeAll(): void {
    for (const peerHandle of [...this.peers.keys()]) this.closePeer(peerHandle);
    this.publications.clear();
    this.queues.clear();
  }

  private async applyNegotiation(roomId: string, input: CommunicationsMediaNegotiation): Promise<void> {
    assertNotExpired(input.expiresAt, this.dependencies.now());
    const current = this.peers.get(input.peerHandle);
    if (current && input.generation < current.generation) return;
    if (current && input.generation === current.generation) {
      if (input.negotiationId === current.negotiationId) return;
      throw new Error("Communications returned a conflicting media generation.");
    }
    if (current && (current.callId !== input.callId || current.roomId !== roomId)) this.closePeer(input.peerHandle);

    const state = this.peers.get(input.peerHandle) ?? this.createPeerState(roomId, input);
    state.callId = input.callId;
    state.generation = input.generation;
    state.negotiationId = input.negotiationId;
    state.observedRemoteMids.clear();
    state.readyKinds.clear();
    state.roomId = roomId;
    state.trackBindings = new Map(input.trackBindings.map((binding) => [binding.transceiverMid, binding]));
    state.peer.setConfiguration({ iceServers: input.iceServers });

    await state.peer.setRemoteDescription({ sdp: input.description, type: input.descriptionType });
    assertCurrent(this.peers, input.peerHandle, input);
    await this.attachAuthorizedLocalTracks(state, input);

    if (input.descriptionType === "offer") {
      const answer = await state.peer.createAnswer();
      await state.peer.setLocalDescription(answer);
      await waitForIceGathering(state.peer, Math.min(
        iceGatheringTimeoutMilliseconds,
        Math.max(1, Date.parse(input.expiresAt) - this.dependencies.now()),
      ), this.dependencies);
      assertCurrent(this.peers, input.peerHandle, input);
      assertNotExpired(input.expiresAt, this.dependencies.now());
      const description = state.peer.localDescription;
      if (description?.type !== "answer" || !description.sdp) {
        throw new Error("Communications could not prepare a bounded media answer.");
      }
      await this.dependencies.onAnswer({
        answer: description.sdp,
        generation: input.generation,
        negotiationId: input.negotiationId,
        peerHandle: input.peerHandle,
        roomId,
      });
    }

    await this.sendReadyWhenConnected(input.peerHandle, state);
  }

  private createPeerState(roomId: string, input: CommunicationsMediaNegotiation): PeerState {
    const peer = this.dependencies.createPeer({ iceServers: input.iceServers });
    const state: PeerState = {
      callId: input.callId,
      generation: input.generation,
      negotiationId: input.negotiationId,
      observedRemoteMids: new Set(),
      peer,
      readyKinds: new Set(),
      roomId,
      trackBindings: new Map(),
    };
    peer.addEventListener("track", (event) => this.forwardAuthorizedRemoteTrack(input.peerHandle, event));
    peer.addEventListener("connectionstatechange", () => { void this.sendReadyWhenConnected(input.peerHandle, state); });
    this.peers.set(input.peerHandle, state);
    return state;
  }

  private async attachAuthorizedLocalTracks(state: PeerState, input: CommunicationsMediaNegotiation): Promise<void> {
    const transceivers = state.peer.getTransceivers();
    for (const binding of input.trackBindings) {
      if (binding.role !== "local") continue;
      const transceiver = transceivers.find((item) => item.mid === binding.transceiverMid);
      if (!transceiver) throw new Error("Communications returned an unknown local media slot.");
      const stream = this.publications.get(publicationKey(state.roomId, binding.publicationKind));
      if (!stream) throw new Error("The approved local media source is no longer available.");
      const track = binding.mediaKind === "audio" ? stream.getAudioTracks()[0] : stream.getVideoTracks()[0];
      if (!track) throw new Error("The approved local media source does not match the requested media kind.");
      await transceiver.sender.replaceTrack(track);
      assertCurrent(this.peers, input.peerHandle, input);
    }
  }

  private forwardAuthorizedRemoteTrack(peerHandle: string, event: RTCTrackEvent): void {
    const state = this.peers.get(peerHandle);
    const mid = event.transceiver.mid;
    if (!state || !mid) return;
    const binding = state.trackBindings.get(mid);
    if (!binding || binding.role !== "remote") return;
    if ((binding.mediaKind === "audio") !== (event.track.kind === "audio")) return;
    const stream = event.streams[0] ?? this.dependencies.createStream([event.track]);
    state.observedRemoteMids.add(mid);
    this.dependencies.onRemoteTrack({
      callId: state.callId,
      mediaKind: binding.mediaKind,
      participantConnectionId: binding.participantConnectionId ?? null,
      publicationKind: binding.publicationKind,
      roomId: state.roomId,
      stream,
      trackReference: binding.trackReference,
    });
    void this.sendReadyWhenConnected(peerHandle, state);
  }

  private async sendReadyWhenConnected(peerHandle: string, state: PeerState): Promise<void> {
    if (state.peer.connectionState !== "connected") return;
    if (this.peers.get(peerHandle) !== state) return;
    const readyKinds = [...new Set([...state.trackBindings.entries()]
      .filter(([mid, binding]) => binding.role === "local" || state.observedRemoteMids.has(mid))
      .map(([, binding]) => binding)
      .map((binding) => binding.mediaKind === "audio" ? "audio" as const : "video" as const))];
    for (const inputKind of readyKinds) {
      if (state.readyKinds.has(inputKind)) continue;
      state.readyKinds.add(inputKind);
      try {
        await this.dependencies.onReady({
          callId: state.callId,
          generation: state.generation,
          inputKind,
          negotiationId: state.negotiationId,
          peerHandle,
          roomId: state.roomId,
        });
      } catch (error) {
        state.readyKinds.delete(inputKind);
        throw error;
      }
    }
  }
}

function publicationKey(roomId: string, kind: CommunicationsPublicationKind): string {
  return `${roomId}:${kind}`;
}

function assertNotExpired(expiresAt: string, now: number): void {
  const value = Date.parse(expiresAt);
  if (!Number.isFinite(value) || value <= now) throw new Error("Communications media negotiation expired.");
}

function assertCurrent(
  peers: ReadonlyMap<string, PeerState>,
  peerHandle: string,
  input: CommunicationsMediaNegotiation,
): void {
  const current = peers.get(peerHandle);
  if (!current || current.generation !== input.generation || current.negotiationId !== input.negotiationId) {
    throw new DOMException("The communications media generation changed.", "AbortError");
  }
}

function waitForIceGathering(
  peer: RTCPeerConnection,
  timeoutMilliseconds: number,
  dependencies: Pick<PeerTransportDependencies, "clearTimer" | "setTimer">,
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
      reject(new Error("Communications media negotiation timed out."));
    }, timeoutMilliseconds);
    peer.addEventListener("icegatheringstatechange", complete);
  });
}
