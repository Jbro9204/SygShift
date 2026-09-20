export type CommunicationsAudioOwner = Readonly<{
  kind: "ptt" | "call" | "meeting";
  sessionId: string;
}>;

type SourceKind = "microphone" | "camera" | "screen";

export type CommunicationsMediaDevices = Pick<MediaDevices, "getDisplayMedia" | "getUserMedia">;

export class SygSphereCommunicationsMedia {
  private readonly mediaDevices: CommunicationsMediaDevices;
  private audioOwner: CommunicationsAudioOwner | null = null;
  private captureGeneration = 0;
  private readonly peers = new Map<string, RTCPeerConnection>();
  private readonly sources = new Map<SourceKind, MediaStream>();

  constructor(mediaDevices: CommunicationsMediaDevices) {
    this.mediaDevices = mediaDevices;
  }

  get currentAudioOwner(): CommunicationsAudioOwner | null {
    return this.audioOwner;
  }

  get activeSources(): readonly SourceKind[] {
    return [...this.sources.keys()];
  }

  takeAudioFocus(owner: CommunicationsAudioOwner): number {
    if (sameOwner(this.audioOwner, owner)) return this.captureGeneration;
    this.captureGeneration += 1;
    this.stopSource("microphone");
    this.audioOwner = owner;
    return this.captureGeneration;
  }

  async acquireMicrophone(owner: CommunicationsAudioOwner): Promise<MediaStream> {
    const generation = this.takeAudioFocus(owner);
    const existing = this.sources.get("microphone");
    if (existing) return existing;
    const stream = await this.mediaDevices.getUserMedia({
      audio: {
        autoGainControl: true,
        echoCancellation: true,
        noiseSuppression: true,
      },
      video: false,
    });
    if (generation !== this.captureGeneration || !sameOwner(this.audioOwner, owner)) {
      stopStream(stream);
      throw new DOMException("The audio focus changed before capture completed.", "AbortError");
    }
    // Capture may be prepared before authority is granted, but audio must stay detached until that grant.
    for (const track of stream.getAudioTracks()) track.enabled = false;
    this.sources.set("microphone", stream);
    return stream;
  }

  setMicrophoneMuted(owner: CommunicationsAudioOwner, muted: boolean): boolean {
    if (!sameOwner(this.audioOwner, owner)) return false;
    const stream = this.sources.get("microphone");
    if (!stream) return false;
    for (const track of stream.getAudioTracks()) track.enabled = !muted;
    return true;
  }

  async acquireCamera(): Promise<MediaStream> {
    const generation = this.captureGeneration;
    const existing = this.sources.get("camera");
    if (existing) return existing;
    const stream = await this.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: "user", height: { ideal: 720 }, width: { ideal: 1280 } },
    });
    if (generation !== this.captureGeneration) {
      stopStream(stream);
      throw new DOMException("The media session changed before camera capture completed.", "AbortError");
    }
    this.sources.set("camera", stream);
    return stream;
  }

  async acquireScreen(onEnded: () => void): Promise<MediaStream> {
    const generation = this.captureGeneration;
    this.stopSource("screen");
    const stream = await this.mediaDevices.getDisplayMedia({
      audio: false,
      video: true,
    });
    if (generation !== this.captureGeneration) {
      stopStream(stream);
      throw new DOMException("The media session changed before screen capture completed.", "AbortError");
    }
    const [track] = stream.getVideoTracks();
    track?.addEventListener("ended", () => {
      if (this.sources.get("screen") !== stream) return;
      this.sources.delete("screen");
      onEnded();
    }, { once: true });
    this.sources.set("screen", stream);
    return stream;
  }

  registerPeerConnection(key: string, peer: RTCPeerConnection): void {
    const existing = this.peers.get(key);
    if (existing && existing !== peer) existing.close();
    this.peers.set(key, peer);
  }

  releasePeerConnection(key: string): void {
    this.peers.get(key)?.close();
    this.peers.delete(key);
  }

  releaseAudioFocus(owner?: CommunicationsAudioOwner): void {
    if (owner && !sameOwner(this.audioOwner, owner)) return;
    this.captureGeneration += 1;
    this.stopSource("microphone");
    this.audioOwner = null;
  }

  stopSource(kind: SourceKind): void {
    const stream = this.sources.get(kind);
    if (!stream) return;
    stopStream(stream);
    this.sources.delete(kind);
  }

  stopAll(): void {
    this.captureGeneration += 1;
    for (const stream of this.sources.values()) stopStream(stream);
    this.sources.clear();
    for (const peer of this.peers.values()) peer.close();
    this.peers.clear();
    this.audioOwner = null;
  }
}

function sameOwner(left: CommunicationsAudioOwner | null, right: CommunicationsAudioOwner | null): boolean {
  return left?.kind === right?.kind && left?.sessionId === right?.sessionId;
}

function stopStream(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}
