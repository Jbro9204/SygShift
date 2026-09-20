import { describe, expect, it, vi } from "vitest";
import { SygSphereCommunicationsMedia, type CommunicationsMediaDevices } from "./sygsphereCommunicationsMedia";

function track(kind: "audio" | "video") {
  const listeners = new Map<string, EventListener>();
  return {
    enabled: true,
    kind,
    stop: vi.fn(),
    addEventListener: vi.fn((name: string, listener: EventListener) => listeners.set(name, listener)),
    end: () => listeners.get("ended")?.(new Event("ended")),
  };
}

function stream(...tracks: ReturnType<typeof track>[]) {
  return {
    getAudioTracks: () => tracks.filter((item) => item.kind === "audio"),
    getTracks: () => tracks,
    getVideoTracks: () => tracks.filter((item) => item.kind === "video"),
  } as unknown as MediaStream;
}

describe("SygSphere communications media ownership", () => {
  it("does not request devices until an explicit acquire action", async () => {
    const microphone = stream(track("audio"));
    const devices = {
      getDisplayMedia: vi.fn(),
      getUserMedia: vi.fn().mockResolvedValue(microphone),
    } as unknown as CommunicationsMediaDevices;
    const media = new SygSphereCommunicationsMedia(devices);
    expect(devices.getUserMedia).not.toHaveBeenCalled();
    await media.acquireMicrophone({ kind: "ptt", sessionId: "floor-a" });
    expect(devices.getUserMedia).toHaveBeenCalledTimes(1);
  });

  it("releases the one-time microphone setup probe before push-to-talk begins", async () => {
    const microphoneTrack = track("audio");
    const devices = {
      getDisplayMedia: vi.fn(),
      getUserMedia: vi.fn().mockResolvedValue(stream(microphoneTrack)),
    } as unknown as CommunicationsMediaDevices;
    const media = new SygSphereCommunicationsMedia(devices);

    await media.prepareMicrophone();

    expect(microphoneTrack.stop).toHaveBeenCalledTimes(1);
    expect(media.activeSources).toEqual([]);
    expect(media.currentAudioOwner).toBeNull();
  });

  it("stops old microphone capture before moving from PTT to a private call", async () => {
    const pttTrack = track("audio");
    const callTrack = track("audio");
    const devices = {
      getDisplayMedia: vi.fn(),
      getUserMedia: vi.fn()
        .mockResolvedValueOnce(stream(pttTrack))
        .mockResolvedValueOnce(stream(callTrack)),
    } as unknown as CommunicationsMediaDevices;
    const media = new SygSphereCommunicationsMedia(devices);
    await media.acquireMicrophone({ kind: "ptt", sessionId: "floor-a" });
    await media.acquireMicrophone({ kind: "call", sessionId: "call-a" });
    expect(pttTrack.stop).toHaveBeenCalledTimes(1);
    expect(callTrack.stop).not.toHaveBeenCalled();
    expect(media.currentAudioOwner).toEqual({ kind: "call", sessionId: "call-a" });
  });

  it("stops capture that resolves after its focus became stale", async () => {
    const lateTrack = track("audio");
    let resolveCapture!: (value: MediaStream) => void;
    const devices = {
      getDisplayMedia: vi.fn(),
      getUserMedia: vi.fn(() => new Promise<MediaStream>((resolve) => { resolveCapture = resolve; })),
    } as unknown as CommunicationsMediaDevices;
    const media = new SygSphereCommunicationsMedia(devices);
    const pending = media.acquireMicrophone({ kind: "ptt", sessionId: "floor-a" });
    media.releaseAudioFocus();
    resolveCapture(stream(lateTrack));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(lateTrack.stop).toHaveBeenCalledTimes(1);
  });

  it("mutes only the microphone owned by the active call", async () => {
    const microphoneTrack = track("audio");
    const devices = {
      getDisplayMedia: vi.fn(),
      getUserMedia: vi.fn().mockResolvedValue(stream(microphoneTrack)),
    } as unknown as CommunicationsMediaDevices;
    const media = new SygSphereCommunicationsMedia(devices);
    const owner = { kind: "call", sessionId: "call-a" } as const;
    await media.acquireMicrophone(owner);

    expect(microphoneTrack.enabled).toBe(false);
    expect(media.setMicrophoneMuted(owner, true)).toBe(true);
    expect(microphoneTrack.enabled).toBe(false);
    expect(media.setMicrophoneMuted({ kind: "call", sessionId: "call-b" }, false)).toBe(false);
    expect(microphoneTrack.enabled).toBe(false);
    expect(media.setMicrophoneMuted(owner, false)).toBe(true);
    expect(microphoneTrack.enabled).toBe(true);
  });

  it("releases screen state when the browser stops sharing", async () => {
    const screenTrack = track("video");
    const devices = {
      getDisplayMedia: vi.fn().mockResolvedValue(stream(screenTrack)),
      getUserMedia: vi.fn(),
    } as unknown as CommunicationsMediaDevices;
    const media = new SygSphereCommunicationsMedia(devices);
    const ended = vi.fn();
    await media.acquireScreen(ended);
    screenTrack.end();
    expect(ended).toHaveBeenCalledTimes(1);
    expect(media.activeSources).not.toContain("screen");
  });

  it("closes every track and peer connection during session cleanup", async () => {
    const microphoneTrack = track("audio");
    const devices = {
      getDisplayMedia: vi.fn(),
      getUserMedia: vi.fn().mockResolvedValue(stream(microphoneTrack)),
    } as unknown as CommunicationsMediaDevices;
    const media = new SygSphereCommunicationsMedia(devices);
    const peer = { close: vi.fn() } as unknown as RTCPeerConnection;
    media.registerPeerConnection("call-a", peer);
    await media.acquireMicrophone({ kind: "call", sessionId: "call-a" });
    media.stopAll();
    expect(microphoneTrack.stop).toHaveBeenCalledTimes(1);
    expect(peer.close).toHaveBeenCalledTimes(1);
    expect(media.currentAudioOwner).toBeNull();
  });
});
