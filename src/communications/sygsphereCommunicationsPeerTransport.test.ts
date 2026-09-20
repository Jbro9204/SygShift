import { describe, expect, it, vi } from "vitest";
import {
  SygSphereCommunicationsPeerTransport,
  type CommunicationsMediaNegotiation,
} from "./sygsphereCommunicationsPeerTransport";

const audioTrack = { kind: "audio" } as MediaStreamTrack;
const videoTrack = { kind: "video" } as MediaStreamTrack;

function stream(...tracks: MediaStreamTrack[]): MediaStream {
  return {
    getAudioTracks: () => tracks.filter((track) => track.kind === "audio"),
    getVideoTracks: () => tracks.filter((track) => track.kind === "video"),
  } as MediaStream;
}

class FakePeer {
  connectionState: RTCPeerConnectionState = "connected";
  iceGatheringState: RTCIceGatheringState = "complete";
  localDescription: RTCSessionDescription | null = null;
  readonly close = vi.fn();
  readonly createAnswer = vi.fn(async () => ({ sdp: "bounded-answer", type: "answer" as const }));
  readonly replaceAudio = vi.fn(async () => undefined);
  readonly replaceVideo = vi.fn(async () => undefined);
  readonly setConfiguration = vi.fn();
  readonly setRemoteDescription = vi.fn(async () => undefined);
  readonly setLocalDescription = vi.fn(async (description: RTCLocalSessionDescriptionInit) => {
    this.localDescription = description as RTCSessionDescription;
  });
  private readonly listeners = new Map<string, Set<EventListener>>();
  private readonly transceivers = [
    { mid: "local_audio", sender: { replaceTrack: this.replaceAudio } },
    { mid: "remote_video", sender: { replaceTrack: this.replaceVideo } },
  ] as unknown as RTCRtpTransceiver[];

  addEventListener(name: string, listener: EventListener): void {
    const listeners = this.listeners.get(name) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(name, listeners);
  }

  removeEventListener(name: string, listener: EventListener): void {
    this.listeners.get(name)?.delete(listener);
  }

  getTransceivers(): RTCRtpTransceiver[] {
    return this.transceivers;
  }

  emitTrack(mid: string, track: MediaStreamTrack, mediaStream = stream(track)): void {
    const event = {
      streams: [mediaStream],
      track,
      transceiver: { mid },
    } as unknown as RTCTrackEvent;
    for (const listener of this.listeners.get("track") ?? []) listener(event as unknown as Event);
  }
}

function negotiation(overrides: Partial<CommunicationsMediaNegotiation> = {}): CommunicationsMediaNegotiation {
  return {
    callId: "4896f7c0-7143-48f9-9978-d1f6a342186f",
    description: "bounded-offer",
    descriptionType: "offer",
    direction: "duplex",
    expiresAt: "2026-09-19T21:01:00.000Z",
    generation: 1,
    iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }],
    negotiationId: "d285bf11-15f6-4efe-b60f-4ab891637342",
    peerHandle: "peer-handle-a",
    trackBindings: [
      {
        mediaKind: "audio",
        publicationKind: "call_audio",
        role: "local",
        trackReference: "track-local-audio",
        transceiverMid: "local_audio",
      },
      {
        mediaKind: "video",
        participantConnectionId: "8d2f99e1-0915-4517-88e0-c344ba284df8",
        publicationKind: "camera",
        role: "remote",
        trackReference: "track-remote-video",
        transceiverMid: "remote_video",
      },
    ],
    ...overrides,
  };
}

function harness(now = Date.parse("2026-09-19T21:00:00.000Z")) {
  const peer = new FakePeer();
  const onAnswer = vi.fn(async () => undefined);
  const onReady = vi.fn(async () => undefined);
  const onRemoteTrack = vi.fn();
  const createPeer = vi.fn(() => peer as unknown as RTCPeerConnection);
  const transport = new SygSphereCommunicationsPeerTransport({
    clearTimer: (timer) => clearTimeout(timer),
    createPeer,
    createStream: (tracks) => stream(...tracks),
    now: () => now,
    onAnswer,
    onReady,
    onRemoteTrack,
    setTimer: (callback, delay) => setTimeout(callback, delay),
  });
  return { createPeer, onAnswer, onReady, onRemoteTrack, peer, transport };
}

describe("SygSphere Draft 4 browser peer transport", () => {
  it("attaches only registered local media and returns the bounded generation-fenced answer", async () => {
    const test = harness();
    test.transport.registerPublication("room-a", "call_audio", stream(audioTrack));
    await test.transport.handleNegotiation("room-a", negotiation());

    expect(test.peer.setRemoteDescription).toHaveBeenCalledWith({ sdp: "bounded-offer", type: "offer" });
    expect(test.peer.replaceAudio).toHaveBeenCalledWith(audioTrack);
    expect(test.onAnswer).toHaveBeenCalledWith({
      answer: "bounded-answer",
      generation: 1,
      negotiationId: "d285bf11-15f6-4efe-b60f-4ab891637342",
      peerHandle: "peer-handle-a",
      roomId: "room-a",
    });
    expect(test.onReady).toHaveBeenCalledWith(expect.objectContaining({ inputKind: "audio", roomId: "room-a" }));
  });

  it("renders only a remote track whose server-issued receiver MID is authorized", async () => {
    const test = harness();
    test.transport.registerPublication("room-a", "call_audio", stream(audioTrack));
    await test.transport.handleNegotiation("room-a", negotiation());
    test.peer.emitTrack("unknown_mid", videoTrack);
    expect(test.onRemoteTrack).not.toHaveBeenCalled();

    const remoteStream = stream(videoTrack);
    test.peer.emitTrack("remote_video", videoTrack, remoteStream);
    expect(test.onRemoteTrack).toHaveBeenCalledWith({
      callId: "4896f7c0-7143-48f9-9978-d1f6a342186f",
      mediaKind: "video",
      participantConnectionId: "8d2f99e1-0915-4517-88e0-c344ba284df8",
      publicationKind: "camera",
      roomId: "room-a",
      stream: remoteStream,
      trackReference: "track-remote-video",
    });
  });

  it("rejects expired or conflicting negotiations and ignores stale generations", async () => {
    const test = harness();
    test.transport.registerPublication("room-a", "call_audio", stream(audioTrack));
    await expect(test.transport.handleNegotiation("room-a", negotiation({
      expiresAt: "2026-09-19T20:59:59.000Z",
    }))).rejects.toThrow("expired");
    expect(test.createPeer).not.toHaveBeenCalled();

    await test.transport.handleNegotiation("room-a", negotiation({ generation: 2 }));
    await test.transport.handleNegotiation("room-a", negotiation({ generation: 1 }));
    expect(test.onAnswer).toHaveBeenCalledTimes(1);
    await expect(test.transport.handleNegotiation("room-a", negotiation({
      generation: 2,
      negotiationId: "8d2f99e1-0915-4517-88e0-c344ba284df8",
    }))).rejects.toThrow("conflicting");
  });

  it("detaches a stopped publication and closes every peer during session cleanup", async () => {
    const test = harness();
    test.transport.registerPublication("room-a", "call_audio", stream(audioTrack));
    await test.transport.handleNegotiation("room-a", negotiation());
    await test.transport.removePublication("room-a", "call_audio");
    expect(test.peer.replaceAudio).toHaveBeenLastCalledWith(null);
    test.transport.closeAll();
    expect(test.peer.close).toHaveBeenCalledTimes(1);
  });
});
