import {
  SYGSPHERE_COMMS_PROTOCOL_VERSION,
  type SygSphereCommsCommandKind,
  type SygSphereCommsEvent,
} from "../../shared/sygsphere-communications/v1/contract";
import type { SygSphereCommunicationsMedia } from "./sygsphereCommunicationsMedia";
import type { CommunicationsRemoteTrack } from "./sygsphereCommunicationsPeerTransport";
import {
  createCommunicationsRuntimeState,
  reduceCommunicationsRuntime,
  type CommunicationsRuntimeState,
} from "./sygsphereCommunicationsState";

export type CommunicationsPublicationKind = "ptt" | "call_audio" | "camera" | "screen";

export interface CommunicationsCoordinatorSession {
  close(reason: string): void;
  publish(input: Readonly<{
    channelReference?: string;
    kind: CommunicationsPublicationKind;
    roomId: string;
    stream: MediaStream;
    transmissionRequestId?: string;
  }>): Promise<void>;
  send(input: Readonly<{
    commandId: string;
    connectionEpoch: number;
    expectedRoomVersion?: number;
    kind: SygSphereCommsCommandKind;
    payload: Record<string, unknown>;
    protocolVersion: typeof SYGSPHERE_COMMS_PROTOCOL_VERSION;
    roomId?: string;
  }>): Promise<void>;
  stopPublication(kind: CommunicationsPublicationKind, roomId?: string): Promise<void>;
}

export interface CommunicationsCoordinatorBridge {
  connect(input: Readonly<{
    accountKey: string;
    onDisconnect: (reason: string, recoverable: boolean) => void;
    onEvent: (event: SygSphereCommsEvent) => void;
    onRemoteTrack?: (track: CommunicationsRemoteTrack) => void;
  }>): Promise<Readonly<{
    authorizationExpiresAt: string | null;
    connectionEpoch: number;
    session: CommunicationsCoordinatorSession;
  }>>;
}

type StateListener = (state: CommunicationsRuntimeState) => void;
type RemoteMediaListener = (tracks: readonly CommunicationsRemoteTrack[]) => void;
type ControllerTimer = ReturnType<typeof setTimeout>;
type CommunicationsControllerDependencies = Readonly<{
  clearTimer: (timer: ControllerTimer) => void;
  now: () => number;
  setTimer: (callback: () => void, delay: number) => ControllerTimer;
}>;

const reconnectDelaysMilliseconds = [500, 1_000, 2_000, 4_000, 8_000] as const;
const defaultControllerDependencies: CommunicationsControllerDependencies = {
  clearTimer: (timer) => clearTimeout(timer),
  now: () => Date.now(),
  setTimer: (callback, delay) => setTimeout(callback, delay),
};
const floorRenewalIntervalMilliseconds = 2_000;

export class SygSphereCommunicationsController {
  private readonly bridge: CommunicationsCoordinatorBridge;
  private readonly media: SygSphereCommunicationsMedia;
  private readonly dependencies: CommunicationsControllerDependencies;
  private connectGeneration = 0;
  private coordinator: CommunicationsCoordinatorSession | null = null;
  private floorLeaseTimer: ControllerTimer | null = null;
  private floorRenewalTimer: ControllerTimer | null = null;
  private listeners = new Set<StateListener>();
  private pendingCamera: Readonly<{ callId: string; stream: MediaStream }> | null = null;
  private pendingCallAudio = new Map<string, MediaStream>();
  private pendingCreatedMeetingId: string | null = null;
  private pendingPttAudio: MediaStream | null = null;
  private pendingFloorRenewalCommandId: string | null = null;
  private pendingScreen: Readonly<{ callId: string; stream: MediaStream }> | null = null;
  private readonly remoteMedia = new Map<string, CommunicationsRemoteTrack>();
  private readonly remoteMediaListeners = new Set<RemoteMediaListener>();
  private reconnectTimer: ControllerTimer | null = null;
  private state = createCommunicationsRuntimeState();

  constructor(
    bridge: CommunicationsCoordinatorBridge,
    media: SygSphereCommunicationsMedia,
    dependencies: CommunicationsControllerDependencies = defaultControllerDependencies,
  ) {
    this.bridge = bridge;
    this.media = media;
    this.dependencies = dependencies;
  }

  get snapshot(): CommunicationsRuntimeState {
    return this.state;
  }

  get remoteMediaSnapshot(): readonly CommunicationsRemoteTrack[] {
    return [...this.remoteMedia.values()];
  }

  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  subscribeRemoteMedia(listener: RemoteMediaListener): () => void {
    this.remoteMediaListeners.add(listener);
    listener(this.remoteMediaSnapshot);
    return () => this.remoteMediaListeners.delete(listener);
  }

  async start(accountKey: string): Promise<void> {
    this.stop("account_changed");
    const generation = ++this.connectGeneration;
    this.update({ type: "account.changed", accountKey });
    this.update({ type: "authorization.started" });
    await this.connectAccount(accountKey, generation, 0);
  }

  private async connectAccount(accountKey: string, generation: number, reconnectAttempt: number): Promise<void> {
    try {
      const connected = await this.bridge.connect({
        accountKey,
        onDisconnect: (reason, recoverable) => this.handleDisconnect(generation, accountKey, reason, recoverable),
        onEvent: (event) => {
          void this.handleEvent(generation, event).catch((error) => this.handleMediaFailure(generation, error));
        },
        onRemoteTrack: (track) => this.handleRemoteTrack(generation, track),
      });
      if (generation !== this.connectGeneration) {
        connected.session.close("stale_connection");
        return;
      }
      this.coordinator = connected.session;
      this.update({ type: "connection.started", connectionEpoch: connected.connectionEpoch });
      this.update({ type: "connection.ready", authorizationExpiresAt: connected.authorizationExpiresAt });
    } catch (error) {
      if (generation !== this.connectGeneration) return;
      const recoverable = reconnectAttempt < reconnectDelaysMilliseconds.length;
      this.update({ type: "connection.lost", recoverable, reason: safeError(error) });
      if (recoverable) this.scheduleReconnect(accountKey, generation, reconnectAttempt);
    }
  }

  stop(reason = "session_ended"): void {
    this.connectGeneration += 1;
    if (this.reconnectTimer) this.dependencies.clearTimer(this.reconnectTimer);
    this.reconnectTimer = null;
    this.clearFloorLeaseTimers();
    this.coordinator?.close(reason);
    this.coordinator = null;
    this.pendingCreatedMeetingId = null;
    this.pendingCallAudio.clear();
    this.pendingCamera = null;
    this.pendingPttAudio = null;
    this.pendingScreen = null;
    this.clearRemoteMedia();
    this.media.stopAll();
    this.update({ type: "session.ended" });
  }

  async holdToTalk(channelReference: string): Promise<void> {
    if (!this.coordinator || this.state.connection !== "ready" || this.state.call || hasActiveFloor(this.state)) return;
    const requestId = crypto.randomUUID();
    this.update({ type: "floor.requested", channelReference, requestId });
    try {
      const stream = await this.media.acquireMicrophone({ kind: "ptt", sessionId: requestId });
      if (this.state.floor?.requestId !== requestId || this.state.floor.status === "releasing") {
        this.media.releaseAudioFocus({ kind: "ptt", sessionId: requestId });
        return;
      }
      this.pendingPttAudio = stream;
      await this.send("floor.request", { channelReference, clientIntentId: requestId });
    } catch (error) {
      this.pendingPttAudio = null;
      this.media.releaseAudioFocus({ kind: "ptt", sessionId: requestId });
      this.update({ type: "floor.failed", reason: safeError(error) });
    }
  }

  async releaseToTalk(): Promise<void> {
    const floor = this.state.floor;
    if (!floor) return;
    this.clearFloorLeaseTimers();
    this.update({ type: "floor.release.requested" });
    this.pendingPttAudio = null;
    this.media.releaseAudioFocus({ kind: "ptt", sessionId: floor.requestId });
    await this.coordinator?.stopPublication("ptt", floor.roomId ?? undefined).catch(() => undefined);
    const kind = floor.status === "requesting" || floor.status === "preparing" ? "floor.cancel" : "floor.release";
    await this.send(kind, { transmissionRequestId: floor.requestId }, floor.roomId ?? undefined).catch(() => undefined);
  }

  async answerCall(callId: string, invitationId: string): Promise<void> {
    if (!this.coordinator || this.state.call?.callId !== callId) return;
    try {
      const stream = await this.media.acquireMicrophone({ kind: "call", sessionId: callId });
      if (this.state.call?.callId !== callId || this.state.call.status !== "ringing") {
        this.media.releaseAudioFocus({ kind: "call", sessionId: callId });
        return;
      }
      this.pendingCallAudio.set(callId, stream);
      await this.send("call.accept", { invitationId }, this.state.call.roomId);
    } catch (error) {
      this.pendingCallAudio.delete(callId);
      this.media.releaseAudioFocus({ kind: "call", sessionId: callId });
      throw error;
    }
  }

  async startCall(conversationReference: string): Promise<void> {
    await this.send("call.request", {
      clientIntentId: crypto.randomUUID(),
      conversationReference,
    });
  }

  async createMeeting(conversationReference: string): Promise<void> {
    const meetingId = crypto.randomUUID();
    this.pendingCreatedMeetingId = meetingId;
    try {
      await this.send("meeting.create", {
        clientIntentId: meetingId,
        conversationReference,
      });
    } catch (error) {
      if (this.pendingCreatedMeetingId === meetingId) this.pendingCreatedMeetingId = null;
      throw error;
    }
  }

  async joinMeeting(meetingId: string): Promise<void> {
    try {
      const stream = await this.media.acquireMicrophone({ kind: "meeting", sessionId: meetingId });
      this.pendingCallAudio.set(meetingId, stream);
      const roomId = this.state.call?.callId === meetingId ? this.state.call.roomId : undefined;
      await this.send("meeting.join", { meetingId }, roomId);
    } catch (error) {
      this.pendingCallAudio.delete(meetingId);
      this.media.releaseAudioFocus({ kind: "meeting", sessionId: meetingId });
      throw error;
    }
  }

  async answerMeeting(meetingId: string): Promise<void> {
    if (this.state.call?.kind !== "meeting" || this.state.call.callId !== meetingId || this.state.call.status !== "ringing") return;
    await this.joinMeeting(meetingId);
  }

  dismissMeetingInvitation(meetingId: string): void {
    this.update({ type: "meeting.dismissed", meetingId });
  }

  async leaveMeeting(meetingId: string): Promise<void> {
    const roomId = this.state.call?.callId === meetingId ? this.state.call.roomId : undefined;
    await this.releaseCallMedia(meetingId, "meeting", roomId);
    await this.send("meeting.leave", { meetingId }, roomId);
  }

  async endMeeting(meetingId: string): Promise<void> {
    const roomId = this.state.call?.callId === meetingId ? this.state.call.roomId : undefined;
    await this.releaseCallMedia(meetingId, "meeting", roomId);
    await this.send("meeting.end", { meetingId }, roomId);
  }

  async moderateParticipant(meetingId: string, participantConnectionId: string, action: "mute" | "remove"): Promise<void> {
    await this.send(`participant.${action}`, { meetingId, participantConnectionId }, this.state.call?.roomId);
  }

  async declineCall(invitationId: string): Promise<void> {
    const roomId = this.state.call?.roomId;
    await this.send("call.decline", { invitationId }, roomId);
  }

  async endCall(callId: string): Promise<void> {
    const roomId = this.state.call?.callId === callId ? this.state.call.roomId : undefined;
    await this.releaseCallMedia(callId, "call", roomId);
    await this.send("call.end", { callId }, roomId).catch(() => undefined);
  }

  setCallMicrophoneMuted(callId: string, muted: boolean): boolean {
    if (this.state.call?.callId !== callId || this.state.call.status !== "active") return false;
    return this.media.setMicrophoneMuted({ kind: this.state.call.kind === "meeting" ? "meeting" : "call", sessionId: callId }, muted);
  }

  async setCameraEnabled(callId: string, enabled: boolean): Promise<void> {
    const call = this.state.call;
    if (!call || call.callId !== callId || call.status !== "active") return;
    if (!enabled) {
      this.pendingCamera = null;
      this.media.stopSource("camera");
      await this.coordinator?.stopPublication("camera", call.roomId);
      await this.send("camera.release", { callId }, call.roomId);
      return;
    }
    const stream = await this.media.acquireCamera();
    if (this.state.call?.callId !== callId || this.state.call.status !== "active") {
      this.media.stopSource("camera");
      return;
    }
    this.pendingCamera = { callId, stream };
    await this.send("camera.request", { callId }, call.roomId);
  }

  async shareScreen(callId: string): Promise<void> {
    const call = this.state.call;
    if (!call || call.callId !== callId || call.status !== "active") return;
    const stream = await this.media.acquireScreen(() => void this.releaseScreen(callId));
    if (this.state.call?.callId !== callId || this.state.call.status !== "active") {
      this.media.stopSource("screen");
      return;
    }
    this.pendingScreen = { callId, stream };
    await this.send("screen.request", { callId }, call.roomId);
  }

  private async releaseScreen(callId: string): Promise<void> {
    const roomId = this.state.call?.callId === callId ? this.state.call.roomId : undefined;
    this.pendingScreen = null;
    this.media.stopSource("screen");
    await this.coordinator?.stopPublication("screen", roomId).catch(() => undefined);
    await this.send("screen.release", { callId }, roomId).catch(() => undefined);
  }

  private async releaseCallMedia(callId: string, ownerKind: "call" | "meeting", roomId?: string): Promise<void> {
    this.pendingCallAudio.delete(callId);
    this.pendingCamera = null;
    this.pendingScreen = null;
    this.clearRemoteMedia(roomId);
    this.media.releaseAudioFocus({ kind: ownerKind, sessionId: callId });
    this.media.stopSource("camera");
    this.media.stopSource("screen");
    await Promise.allSettled([
      this.coordinator?.stopPublication("call_audio", roomId),
      this.coordinator?.stopPublication("camera", roomId),
      this.coordinator?.stopPublication("screen", roomId),
    ]);
  }

  private handleDisconnect(generation: number, accountKey: string, reason: string, recoverable: boolean): void {
    if (generation !== this.connectGeneration) return;
    this.coordinator = null;
    this.clearFloorLeaseTimers();
    this.media.stopAll();
    this.pendingCallAudio.clear();
    this.pendingCamera = null;
    this.pendingPttAudio = null;
    this.pendingScreen = null;
    this.clearRemoteMedia();
    this.update({ type: "connection.lost", recoverable, reason });
    if (recoverable) this.scheduleReconnect(accountKey, generation, 0);
  }

  private handleMediaFailure(generation: number, error: unknown): void {
    if (generation !== this.connectGeneration) return;
    this.clearFloorLeaseTimers();
    this.media.stopAll();
    this.pendingCallAudio.clear();
    this.pendingCamera = null;
    this.pendingPttAudio = null;
    this.pendingScreen = null;
    this.clearRemoteMedia();
    this.update({
      type: "local.media.failed",
      reason: `${safeError(error)} Use messages or Dispatch while media reconnects.`,
    });
  }

  private scheduleReconnect(accountKey: string, generation: number, attempt: number): void {
    if (generation !== this.connectGeneration) return;
    const delay = reconnectDelaysMilliseconds[attempt];
    if (delay === undefined) {
      this.update({ type: "connection.lost", recoverable: false, reason: "Communications could not reconnect. Use messages or Dispatch and try again." });
      return;
    }
    if (this.reconnectTimer) this.dependencies.clearTimer(this.reconnectTimer);
    this.reconnectTimer = this.dependencies.setTimer(() => {
      this.reconnectTimer = null;
      if (generation !== this.connectGeneration) return;
      void this.connectAccount(accountKey, generation, attempt + 1);
    }, delay);
  }

  private async handleEvent(generation: number, event: SygSphereCommsEvent): Promise<void> {
    if (generation !== this.connectGeneration) return;
    if (event.kind === "floor.renewed") {
      const commandId = stringPayload(event.payload, "commandId");
      if (!commandId || commandId !== this.pendingFloorRenewalCommandId) return;
      this.pendingFloorRenewalCommandId = null;
    }
    const before = this.state;
    const priorFloor = before.floor;
    this.update({ type: "event.received", event });
    if (this.state === before) return;

    if (event.kind === "floor.ready") {
      const floor = this.state.floor;
      const stream = this.pendingPttAudio;
      if (floor?.roomId === event.roomId && floor.status === "ready" && stream) {
        this.media.setMicrophoneMuted({ kind: "ptt", sessionId: floor.requestId }, false);
        this.armFloorLease(floor.requestId);
      }
    }

    if (event.kind === "floor.preparing") {
      const floor = this.state.floor;
      const stream = this.pendingPttAudio;
      if (floor?.roomId === event.roomId && floor.status === "preparing" && stream) {
        await this.coordinator?.publish({
          channelReference: floor.channelReference,
          kind: "ptt",
          roomId: event.roomId,
          stream,
          transmissionRequestId: floor.requestId,
        });
      }
    }

    if (event.kind === "floor.renewed" && this.state.floor) {
      this.armFloorLease(this.state.floor.requestId);
    }

    if (event.kind === "call.requested") {
      const call = this.state.call;
      if (call?.kind === "direct" && call.status === "connecting") {
        const stream = await this.media.acquireMicrophone({ kind: "call", sessionId: call.callId });
        if (this.state.call?.callId !== call.callId) {
          this.media.releaseAudioFocus({ kind: "call", sessionId: call.callId });
          return;
        }
        this.pendingCallAudio.set(call.callId, stream);
      }
    }

    if (event.kind === "call.accepted") {
      const call = this.state.call;
      if (call?.kind !== "direct") return;
      let stream = this.pendingCallAudio.get(call.callId);
      if (!stream) {
        stream = await this.media.acquireMicrophone({ kind: "call", sessionId: call.callId });
        if (this.state.call?.callId !== call.callId || this.state.call.kind !== "direct") {
          this.media.releaseAudioFocus({ kind: "call", sessionId: call.callId });
          return;
        }
        this.pendingCallAudio.set(call.callId, stream);
      }
      this.media.setMicrophoneMuted({ kind: "call", sessionId: call.callId }, false);
      await this.coordinator?.publish({ kind: "call_audio", roomId: call.roomId, stream });
    }

    if (event.kind === "meeting.created") {
      const call = this.state.call;
      const invited = typeof event.payload === "object" && event.payload !== null
        && (event.payload as Record<string, unknown>).invited === true;
      if (call?.kind === "meeting" && call.status === "connecting" && !invited) {
        this.pendingCreatedMeetingId = null;
        await this.joinMeeting(call.callId);
      }
    }

    if (event.kind === "focus.granted") {
      const call = this.state.call;
      const stream = call ? this.pendingCallAudio.get(call.callId) : null;
      if (call && stream) {
        this.media.setMicrophoneMuted({
          kind: call.kind === "meeting" ? "meeting" : "call",
          sessionId: call.callId,
        }, false);
      }
    }

    if (event.kind === "meeting.joined") {
      const call = this.state.call;
      const stream = call ? this.pendingCallAudio.get(call.callId) : null;
      if (call?.kind === "meeting" && stream) {
        await this.coordinator?.publish({ kind: "call_audio", roomId: call.roomId, stream });
      }
    }

    if (event.kind === "participant.muted" && this.state.microphoneMutedByModerator) {
      const call = this.state.call;
      if (call?.kind === "meeting" && call.roomId === event.roomId) {
        this.media.setMicrophoneMuted({ kind: "meeting", sessionId: call.callId }, true);
      }
    }

    if (event.kind === "media.source.unavailable") {
      const trackReference = stringPayload(event.payload, "trackReference");
      if (trackReference && this.remoteMedia.delete(trackReference)) this.emitRemoteMedia();
    }

    if (event.kind === "screen.granted") {
      const screen = this.pendingScreen;
      if (screen && this.state.call?.callId === screen.callId) {
        await this.coordinator?.publish({ kind: "screen", roomId: event.roomId, stream: screen.stream });
      }
    }

    if (event.kind === "camera.granted") {
      const camera = this.pendingCamera;
      if (camera && this.state.call?.callId === camera.callId) {
        await this.coordinator?.publish({ kind: "camera", roomId: event.roomId, stream: camera.stream });
      }
    }

    if (["floor.denied", "floor.revoked", "transmission.ended"].includes(event.kind) && priorFloor) {
      this.clearFloorLeaseTimers();
      this.pendingPttAudio = null;
      this.media.releaseAudioFocus({ kind: "ptt", sessionId: priorFloor.requestId });
      await this.coordinator?.stopPublication("ptt", event.roomId).catch(() => undefined);
    }

    if (["screen.denied", "screen.revoked"].includes(event.kind)) {
      this.pendingScreen = null;
      this.media.stopSource("screen");
      await this.coordinator?.stopPublication("screen", event.roomId).catch(() => undefined);
    }

    if (["camera.denied", "camera.revoked"].includes(event.kind)) {
      this.pendingCamera = null;
      this.media.stopSource("camera");
      await this.coordinator?.stopPublication("camera", event.roomId).catch(() => undefined);
    }

    if (["session.revoked", "focus.revoked", "call.ended", "call.missed", "meeting.ended", "media.failed"].includes(event.kind)) {
      this.media.stopAll();
      this.pendingCallAudio.clear();
      this.pendingCamera = null;
      this.pendingPttAudio = null;
      this.pendingScreen = null;
      this.clearRemoteMedia(event.roomId);
    }
    if (event.kind === "media.closed") this.clearRemoteMedia(event.roomId);
  }

  private handleRemoteTrack(generation: number, track: CommunicationsRemoteTrack): void {
    if (
      generation !== this.connectGeneration
      || (track.publicationKind !== "ptt" && this.state.call?.roomId !== track.roomId)
    ) return;
    this.remoteMedia.set(track.trackReference, track);
    for (const mediaTrack of track.stream.getTracks()) {
      mediaTrack.addEventListener("ended", () => {
        if (this.remoteMedia.get(track.trackReference) !== track) return;
        this.remoteMedia.delete(track.trackReference);
        this.emitRemoteMedia();
      }, { once: true });
    }
    this.emitRemoteMedia();
  }

  private clearRemoteMedia(roomId?: string): void {
    let changed = false;
    for (const [trackReference, track] of this.remoteMedia) {
      if (roomId && track.roomId !== roomId) continue;
      this.remoteMedia.delete(trackReference);
      changed = true;
    }
    if (changed) this.emitRemoteMedia();
  }

  private emitRemoteMedia(): void {
    const tracks = this.remoteMediaSnapshot;
    for (const listener of this.remoteMediaListeners) listener(tracks);
  }

  private armFloorLease(requestId: string): void {
    const floor = this.state.floor;
    if (!floor || floor.requestId !== requestId || !floor.leaseExpiresAt) {
      this.expireFloorLease(requestId, "PTT authority did not include a valid lease.");
      return;
    }
    const expiresAt = Date.parse(floor.leaseExpiresAt);
    const remaining = expiresAt - this.dependencies.now();
    if (!Number.isFinite(expiresAt) || remaining <= 0) {
      this.expireFloorLease(requestId, "PTT authority expired before transmission was ready.");
      return;
    }
    if (this.floorLeaseTimer) this.dependencies.clearTimer(this.floorLeaseTimer);
    if (this.floorRenewalTimer) this.dependencies.clearTimer(this.floorRenewalTimer);
    this.floorLeaseTimer = this.dependencies.setTimer(() => {
      this.floorLeaseTimer = null;
      this.expireFloorLease(requestId, "PTT lease renewal was not acknowledged in time.");
    }, remaining);
    this.floorRenewalTimer = this.dependencies.setTimer(() => {
      this.floorRenewalTimer = null;
      void this.renewFloorLease(requestId);
    }, Math.min(floorRenewalIntervalMilliseconds, Math.max(1, remaining - 1)));
  }

  private async renewFloorLease(requestId: string): Promise<void> {
    const floor = this.state.floor;
    if (!floor || floor.requestId !== requestId || !floor.roomId || this.pendingFloorRenewalCommandId) return;
    const commandId = crypto.randomUUID();
    this.pendingFloorRenewalCommandId = commandId;
    try {
      await this.send("floor.renew", { transmissionRequestId: requestId }, floor.roomId, commandId);
    } catch (error) {
      if (this.pendingFloorRenewalCommandId === commandId) this.pendingFloorRenewalCommandId = null;
      this.expireFloorLease(requestId, safeError(error));
    }
  }

  private expireFloorLease(requestId: string, reason: string): void {
    const floor = this.state.floor;
    if (!floor || floor.requestId !== requestId) return;
    this.clearFloorLeaseTimers();
    this.pendingPttAudio = null;
    this.media.releaseAudioFocus({ kind: "ptt", sessionId: requestId });
    void this.coordinator?.stopPublication("ptt", floor.roomId ?? undefined).catch(() => undefined);
    void this.send("floor.release", { transmissionRequestId: requestId }, floor.roomId ?? undefined).catch(() => undefined);
    this.update({ type: "floor.failed", reason: `${reason} Release and hold again to retry.` });
  }

  private clearFloorLeaseTimers(): void {
    if (this.floorLeaseTimer) this.dependencies.clearTimer(this.floorLeaseTimer);
    if (this.floorRenewalTimer) this.dependencies.clearTimer(this.floorRenewalTimer);
    this.floorLeaseTimer = null;
    this.floorRenewalTimer = null;
    this.pendingFloorRenewalCommandId = null;
  }

  private async send(kind: SygSphereCommsCommandKind, payload: Record<string, unknown>, roomId?: string, commandId = crypto.randomUUID()): Promise<string> {
    const coordinator = this.coordinator;
    if (!coordinator) throw new Error("Communications are not connected.");
    const version = roomId ? this.state.roomVersions[roomId]?.sequence : undefined;
    await coordinator.send({
      protocolVersion: SYGSPHERE_COMMS_PROTOCOL_VERSION,
      commandId,
      connectionEpoch: this.state.connectionEpoch,
      kind,
      payload,
      ...(roomId ? { roomId } : {}),
      ...(version === undefined ? {} : { expectedRoomVersion: version }),
    });
    return commandId;
  }

  private update(action: Parameters<typeof reduceCommunicationsRuntime>[1]): void {
    const next = reduceCommunicationsRuntime(this.state, action);
    if (next === this.state) return;
    this.state = next;
    for (const listener of this.listeners) listener(next);
  }
}

function stringPayload(payload: unknown, key: string): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function safeError(error: unknown): string {
  if (error instanceof DOMException && error.name === "NotAllowedError") return "Microphone or camera permission was not granted.";
  return "Communications could not be prepared. Use messages or Dispatch and try again.";
}

function hasActiveFloor(state: CommunicationsRuntimeState): boolean {
  return state.floor !== null;
}
