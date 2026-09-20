import {
  Mic,
  MicOff,
  MonitorUp,
  Phone,
  PhoneOff,
  Radio,
  ShieldCheck,
  Video,
  VideoOff,
  WifiOff,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CommunicationsConnectionState } from "../../communications/sygsphereCommunicationsState";
import type { CommunicationsRemoteTrack } from "../../communications/sygsphereCommunicationsPeerTransport";
import "../../styles/sygsphere-communications.css";

export type CommunicationsChannelOption = Readonly<{
  id: string;
  label: string;
  scopeLabel: string;
}>;

export type CommunicationsPanelCall = Readonly<{
  callId: string;
  displayName: string;
  kind: "direct" | "meeting";
  status: "ringing" | "connecting" | "active";
}>;

export type CommunicationsPanelCapabilities = Readonly<{
  call: boolean;
  camera: boolean;
  meeting: boolean;
  ptt: boolean;
  screen: boolean;
}>;

interface SygSphereCommunicationsPanelProps {
  call: CommunicationsPanelCall | null;
  cameraEnabled: boolean;
  capabilities: CommunicationsPanelCapabilities;
  channels: readonly CommunicationsChannelOption[];
  connection: CommunicationsConnectionState;
  conversationKind: "channel" | "direct" | "group";
  conversationName: string;
  microphoneMuted: boolean;
  microphoneMutedByModerator: boolean;
  microphonePrepared: boolean;
  onAnswer: (callId: string) => void;
  onCameraChange: (enabled: boolean) => void;
  onDecline: (callId: string) => void;
  onEndCall: (callId: string) => void;
  onMicrophoneMuteChange: (muted: boolean) => void;
  onPrepareMicrophone: () => void;
  onPttPressEnd: () => void;
  onPttPressStart: (channelId: string) => void;
  onScreenShare: () => void;
  onStartCall: () => void;
  onStartMeeting: () => void;
  pttState: "permission_needed" | "ready" | "requesting" | "transmitting" | "releasing" | "reconnecting" | "denied";
  remoteMedia?: readonly CommunicationsRemoteTrack[];
  selectedChannelId: string;
}

export function SygSphereCommunicationsPanel({
  call,
  cameraEnabled,
  capabilities,
  channels,
  connection,
  conversationKind,
  conversationName,
  microphoneMuted,
  microphoneMutedByModerator,
  microphonePrepared,
  onAnswer,
  onCameraChange,
  onDecline,
  onEndCall,
  onMicrophoneMuteChange,
  onPrepareMicrophone,
  onPttPressEnd,
  onPttPressStart,
  onScreenShare,
  onStartCall,
  onStartMeeting,
  pttState,
  remoteMedia = [],
  selectedChannelId,
}: SygSphereCommunicationsPanelProps) {
  const selectedChannel = channels.find((channel) => channel.id === selectedChannelId) ?? channels[0] ?? null;
  const pttAvailable = capabilities.ptt && connection === "ready" && Boolean(selectedChannel) && !call
    && pttState !== "denied" && pttState !== "releasing";
  const pttEnabled = pttAvailable && microphonePrepared;
  const ptt = useHoldToTalk({
    enabled: pttEnabled,
    onRelease: onPttPressEnd,
    onStart: () => selectedChannel && onPttPressStart(selectedChannel.id),
  });

  return (
    <section aria-label="SygSphere voice and video" className="sphere-comms-panel">
      <div className="sphere-comms-panel__bar">
        <div className="sphere-comms-panel__identity">
          <span><ShieldCheck size={16} /> Voice</span>
          <small>{conversationName}</small>
        </div>
        <ConnectionStatus state={connection} />
        {!call ? (
          <div className="sphere-comms-panel__controls">
            {conversationKind === "channel" ? (
              microphonePrepared ? (
                <button
                  {...ptt.handlers}
                  aria-describedby="sphere-comms-ptt-help"
                  aria-pressed={ptt.pressed}
                  className={`sphere-comms-ptt${ptt.pressed || pttState === "transmitting" ? " is-transmitting" : ""}`}
                  disabled={!pttEnabled}
                  type="button"
                >
                  <Radio size={19} />
                  <span><strong>{pttLabel(pttState, ptt.pressed)}</strong><small>{selectedChannel?.scopeLabel ?? "Channel voice unavailable"}</small></span>
                </button>
              ) : (
                <button
                  aria-describedby="sphere-comms-ptt-help"
                  className="sphere-comms-ptt is-setup"
                  disabled={!pttAvailable}
                  onClick={onPrepareMicrophone}
                  type="button"
                >
                  <Mic size={19} />
                  <span><strong>Set up microphone</strong><small>One-time secure setup</small></span>
                </button>
              )
            ) : null}
            {conversationKind === "direct" ? (
              <button disabled={!capabilities.call || connection !== "ready"} onClick={onStartCall} type="button">
                <Phone size={18} /><span><strong>Call</strong><small>Private voice</small></span>
              </button>
            ) : (
              <button disabled={!capabilities.meeting || connection !== "ready"} onClick={onStartMeeting} type="button">
                <Video size={18} /><span><strong>Meet</strong><small>Voice or video</small></span>
              </button>
            )}
          </div>
        ) : null}
      </div>

      {conversationKind === "channel" && !call ? (
        <p className="sphere-comms-panel__hint" id="sphere-comms-ptt-help">
          {microphonePrepared
            ? "Hold Push to talk while speaking. Release when finished."
            : "Set up your microphone once, then press and hold to talk while speaking."}
        </p>
      ) : null}

      {call?.status === "ringing" ? (
        <section aria-live="assertive" className="sphere-comms-incoming">
          <span><Phone size={22} /></span>
          <div><small>{call.kind === "meeting" ? "Meeting invitation" : "Incoming call"}</small><strong>{call.displayName}</strong></div>
          <button className="is-decline" onClick={() => onDecline(call.callId)} type="button"><PhoneOff size={18} />Decline</button>
          <button className="is-answer" onClick={() => onAnswer(call.callId)} type="button"><Phone size={18} />Answer</button>
        </section>
      ) : null}

      {call && call.status !== "ringing" ? (
        <ActiveCallControls
          call={call}
          cameraEnabled={cameraEnabled}
          capabilities={capabilities}
          microphoneMuted={microphoneMuted}
          microphoneMutedByModerator={microphoneMutedByModerator}
          onCameraChange={onCameraChange}
          onEndCall={onEndCall}
          onMicrophoneMuteChange={onMicrophoneMuteChange}
          onScreenShare={onScreenShare}
          remoteMedia={remoteMedia}
        />
      ) : null}
    </section>
  );
}

function ActiveCallControls({
  call,
  cameraEnabled,
  capabilities,
  microphoneMuted,
  microphoneMutedByModerator,
  onCameraChange,
  onEndCall,
  onMicrophoneMuteChange,
  onScreenShare,
  remoteMedia,
}: Pick<SygSphereCommunicationsPanelProps, "cameraEnabled" | "capabilities" | "microphoneMuted" | "microphoneMutedByModerator" | "onCameraChange" | "onEndCall" | "onMicrophoneMuteChange" | "onScreenShare"> & { call: CommunicationsPanelCall; remoteMedia: readonly CommunicationsRemoteTrack[] }) {
  return (
    <section aria-label="Active call controls" className="sphere-comms-active">
      <div className="sphere-comms-active__identity">
        <span className={call.status === "active" ? "is-live" : undefined}><Phone size={21} /></span>
        <div><small>{call.kind === "meeting" ? "Team meeting" : "Private call"}</small><strong>{call.displayName}</strong><p>{call.status === "active" ? "Connected" : "Connecting securely…"}</p></div>
      </div>
      <RemoteMediaStage tracks={remoteMedia} />
      <div className="sphere-comms-active__controls">
        <button aria-pressed={microphoneMuted} disabled={microphoneMutedByModerator} onClick={() => onMicrophoneMuteChange(!microphoneMuted)} type="button">
          {microphoneMuted ? <MicOff size={19} /> : <Mic size={19} />}<span>{microphoneMutedByModerator ? "Muted by moderator" : microphoneMuted ? "Unmute" : "Mute"}</span>
        </button>
        <button aria-pressed={cameraEnabled} disabled={!capabilities.camera} onClick={() => onCameraChange(!cameraEnabled)} type="button">
          {cameraEnabled ? <Video size={19} /> : <VideoOff size={19} />}<span>{cameraEnabled ? "Stop camera" : "Camera"}</span>
        </button>
        <button disabled={!capabilities.screen} onClick={onScreenShare} type="button"><MonitorUp size={19} /><span>Share screen</span></button>
        <button className="is-end" onClick={() => onEndCall(call.callId)} type="button"><PhoneOff size={19} /><span>End</span></button>
      </div>
    </section>
  );
}

function RemoteMediaStage({ tracks }: { tracks: readonly CommunicationsRemoteTrack[] }) {
  const screens = tracks.filter((track) => track.mediaKind === "screen");
  const cameras = tracks.filter((track) => track.mediaKind === "video");
  return (
    <section aria-label="Call media" className="sphere-comms-media-stage">
      {screens.map((track) => <RemoteMediaElement featured kind="video" key={track.trackReference} label="Shared screen" stream={track.stream} />)}
      {cameras.length > 0 && (
        <div className="sphere-comms-media-stage__grid">
          {cameras.map((track) => <RemoteMediaElement kind="video" key={track.trackReference} label="Team member camera" stream={track.stream} />)}
        </div>
      )}
      {screens.length === 0 && cameras.length === 0 && (
        <div className="sphere-comms-media-stage__voice"><Phone size={25} /><div><strong>Voice call connected</strong><span>Camera and screen sharing remain off until someone chooses them.</span></div></div>
      )}
    </section>
  );
}

function RemoteMediaElement({ featured = false, kind, label, stream }: {
  featured?: boolean;
  kind: "audio" | "video";
  label: string;
  stream: MediaStream;
}) {
  const elementRef = useRef<HTMLMediaElement | null>(null);
  useEffect(() => {
    const element = elementRef.current;
    if (!element) return;
    element.srcObject = stream;
    return () => {
      if (element.srcObject === stream) element.srcObject = null;
    };
  }, [stream]);
  if (kind === "audio") return <audio aria-label={label} autoPlay ref={(element) => { elementRef.current = element; }} />;
  return <video aria-label={label} autoPlay className={featured ? "is-featured" : undefined} playsInline ref={(element) => { elementRef.current = element; }} />;
}

function ConnectionStatus({ state }: { state: CommunicationsConnectionState }) {
  const detail = {
    unavailable: ["Not available", "Use messages or Dispatch"],
    authorizing: ["Checking access", "One moment"],
    connecting: ["Connecting", "One moment"],
    ready: ["Ready", "Voice and video available"],
    reconnecting: ["Reconnecting", "Do not speak yet"],
    denied: ["Access unavailable", "Use messages or Dispatch"],
    failed: ["Connection unavailable", "Use messages or Dispatch"],
  }[state];
  return <div className={`sphere-comms-status is-${state}`} role="status">{state === "failed" || state === "denied" || state === "unavailable" ? <WifiOff size={18} /> : <span aria-hidden="true" />}<span><strong>{detail[0]}</strong><small>{detail[1]}</small></span></div>;
}

function pttLabel(state: SygSphereCommunicationsPanelProps["pttState"], pressed: boolean): string {
  if (pressed || state === "transmitting") return "Talking now — release to stop";
  if (state === "releasing") return "Releasing…";
  if (state === "permission_needed") return "Hold to allow microphone";
  if (state === "requesting") return "Preparing your channel…";
  if (state === "reconnecting") return "Reconnecting…";
  if (state === "denied") return "Channel unavailable";
  return "Hold to talk";
}

function useHoldToTalk({ enabled, onRelease, onStart }: { enabled: boolean; onRelease: () => void; onStart: () => void }) {
  const [pressed, setPressed] = useState(false);
  const enabledRef = useRef(enabled);
  const onReleaseRef = useRef(onRelease);
  const onStartRef = useRef(onStart);
  const pressedRef = useRef(false);
  enabledRef.current = enabled;
  onReleaseRef.current = onRelease;
  onStartRef.current = onStart;
  const start = useCallback(() => {
    if (!enabledRef.current || pressedRef.current) return;
    pressedRef.current = true;
    setPressed(true);
    onStartRef.current();
  }, []);
  const release = useCallback(() => {
    if (!pressedRef.current) return;
    pressedRef.current = false;
    setPressed(false);
    onReleaseRef.current();
  }, []);

  useEffect(() => {
    const stopWhenHidden = () => { if (document.visibilityState === "hidden") release(); };
    window.addEventListener("blur", release);
    window.addEventListener("pointercancel", release, true);
    window.addEventListener("pointerup", release, true);
    window.addEventListener("touchcancel", release, true);
    window.addEventListener("touchend", release, true);
    document.addEventListener("visibilitychange", stopWhenHidden);
    return () => {
      release();
      window.removeEventListener("blur", release);
      window.removeEventListener("pointercancel", release, true);
      window.removeEventListener("pointerup", release, true);
      window.removeEventListener("touchcancel", release, true);
      window.removeEventListener("touchend", release, true);
      document.removeEventListener("visibilitychange", stopWhenHidden);
    };
  }, [release]);

  return {
    handlers: {
      onBlur: release,
      onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => {
        if ((event.key === " " || event.key === "Enter") && !event.repeat) { event.preventDefault(); start(); }
      },
      onKeyUp: (event: React.KeyboardEvent<HTMLButtonElement>) => {
        if (event.key === " " || event.key === "Enter") { event.preventDefault(); release(); }
      },
      onLostPointerCapture: release,
      onPointerCancel: release,
      onPointerDown: (event: React.PointerEvent<HTMLButtonElement>) => {
        if (event.button !== 0) return;
        try {
          event.currentTarget.setPointerCapture?.(event.pointerId);
        } catch {
          // The window-level release fallback handles browsers that decline capture.
        }
        start();
      },
      onPointerUp: release,
    },
    pressed,
  };
}
