import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Phone, PhoneOff, Volume2 } from "lucide-react";
import type { SphereConversation } from "../../data/sygsphere";
import { getSupabaseClient } from "../../lib/supabase";
import {
  assessCommunicationsBrowserCapabilities,
  readCommunicationsBrowserEnvironment,
} from "../../communications/sygsphereCommunicationsBrowserCapabilities";
import { SygSphereCommunicationsController } from "../../communications/sygsphereCommunicationsController";
import { SygSphereCommunicationsMedia } from "../../communications/sygsphereCommunicationsMedia";
import type { CommunicationsRemoteTrack } from "../../communications/sygsphereCommunicationsPeerTransport";
import { SYGSPHERE_COMMS_CLIENT_RUNTIME_RELEASED } from "../../communications/sygsphereCommunicationsRuntimeLifecycle";
import { SygSphereCommunicationsSocketBridge } from "../../communications/sygsphereCommunicationsSocketBridge";
import {
  createCommunicationsRuntimeState,
  type CommunicationsRuntimeState,
} from "../../communications/sygsphereCommunicationsState";
import {
  SygSphereCommunicationsPanel,
  type CommunicationsPanelCapabilities,
  type CommunicationsPanelCall,
} from "./SygSphereCommunicationsPanel";

const incomingCallSound = "/sounds/SygSphere_Notification_46421aca.mp3";
const incomingCallSoundIntervalMilliseconds = 4_000;

type CommunicationsRuntimeContextValue = Readonly<{
  browser: ReturnType<typeof assessCommunicationsBrowserCapabilities>;
  controller: SygSphereCommunicationsController | null;
  lastActionError: string | null;
  permissions: readonly string[];
  remoteMedia: readonly CommunicationsRemoteTrack[];
  state: CommunicationsRuntimeState;
  run: (action: (controller: SygSphereCommunicationsController) => Promise<void> | void) => Promise<void>;
}>;

const CommunicationsRuntimeContext = createContext<CommunicationsRuntimeContextValue | null>(null);
const unavailableBrowserCapabilities = assessCommunicationsBrowserCapabilities({
  hasDisplayMedia: false,
  hasGetUserMedia: false,
  hasPeerConnection: false,
  hasWebSocket: false,
  secureContext: false,
});
const unavailableRuntimeContext: CommunicationsRuntimeContextValue = {
  browser: unavailableBrowserCapabilities,
  controller: null,
  lastActionError: null,
  permissions: [],
  remoteMedia: [],
  run: async () => undefined,
  state: createCommunicationsRuntimeState(),
};

export function SygSphereCommunicationsRuntimeProvider({
  children,
  employeeId,
  enabled,
  permissions,
}: {
  children: ReactNode;
  employeeId: string | null;
  enabled: boolean;
  permissions: readonly string[];
}) {
  const accessTokenRef = useRef<string | null>(null);
  const [state, setState] = useState<CommunicationsRuntimeState>(() => createCommunicationsRuntimeState());
  const [remoteMedia, setRemoteMedia] = useState<readonly CommunicationsRemoteTrack[]>([]);
  const [lastActionError, setLastActionError] = useState<string | null>(null);
  const [audioBlocked, setAudioBlocked] = useState(false);
  const callAudio = useRef<HTMLAudioElement | null>(null);
  const browser = useMemo(
    () => assessCommunicationsBrowserCapabilities(readCommunicationsBrowserEnvironment()),
    [],
  );
  const controller = useMemo(() => {
    if (!SYGSPHERE_COMMS_CLIENT_RUNTIME_RELEASED || !browser.controlTransport.available || !browser.webRtcMedia.available) {
      return null;
    }
    const mediaDevices = typeof navigator === "undefined" ? null : navigator.mediaDevices;
    if (!mediaDevices?.getUserMedia) return null;
    const captureDevices = {
      getDisplayMedia: typeof mediaDevices.getDisplayMedia === "function"
        ? mediaDevices.getDisplayMedia.bind(mediaDevices)
        : async () => { throw new DOMException("Screen sharing is not supported on this device.", "NotSupportedError"); },
      getUserMedia: mediaDevices.getUserMedia.bind(mediaDevices),
    };
    return new SygSphereCommunicationsController(
      new SygSphereCommunicationsSocketBridge(() => accessTokenRef.current),
      new SygSphereCommunicationsMedia(captureDevices),
    );
  }, [browser.controlTransport.available, browser.webRtcMedia.available]);

  useEffect(() => {
    const sound = new Audio(incomingCallSound);
    sound.preload = "auto";
    callAudio.current = sound;
    const unlock = () => {
      sound.muted = true;
      const playback = sound.play();
      if (!playback || typeof playback.then !== "function") {
        sound.muted = false;
        return;
      }
      void playback
        .then(() => {
          sound.pause();
          sound.currentTime = 0;
          sound.muted = false;
        })
        .catch(() => {
          sound.muted = false;
        });
    };
    window.addEventListener("pointerdown", unlock, { once: true });
    window.addEventListener("keydown", unlock, { once: true });
    return () => {
      sound.pause();
      callAudio.current = null;
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, []);

  useEffect(() => {
    if (!controller) return;
    const unsubscribeState = controller.subscribe(setState);
    const unsubscribeMedia = controller.subscribeRemoteMedia(setRemoteMedia);
    return () => {
      unsubscribeMedia();
      unsubscribeState();
    };
  }, [controller]);

  useEffect(() => {
    if (!controller || !enabled || !employeeId) {
      accessTokenRef.current = null;
      controller?.stop("signed_out");
      return;
    }
    let cancelled = false;
    setLastActionError(null);
    void getSupabaseClient().auth.getSession().then(({ data, error }) => {
      if (cancelled || error || !data.session?.access_token) {
        if (!cancelled) setLastActionError("Your secure SygSphere session is unavailable. Sign in again.");
        return;
      }
      accessTokenRef.current = data.session.access_token;
      return controller.start(employeeId);
    }).catch(() => {
      if (!cancelled) setLastActionError("Communications could not open. Continue with messages or Dispatch and try again.");
    });
    return () => {
      cancelled = true;
      accessTokenRef.current = null;
      controller.stop("account_changed");
    };
  }, [controller, employeeId, enabled]);

  const run = useCallback(async (
    action: (activeController: SygSphereCommunicationsController) => Promise<void> | void,
  ) => {
    if (!controller) {
      setLastActionError("Voice and video are not supported in this browser. Continue with messages or Dispatch.");
      return;
    }
    setLastActionError(null);
    try {
      await action(controller);
    } catch (error) {
      setLastActionError(publicCommunicationsError(error));
    }
  }, [controller]);

  const playIncomingCallSound = useCallback(async () => {
    const sound = callAudio.current;
    if (!sound) return false;
    sound.pause();
    sound.volume = 0.72;
    sound.currentTime = 0;
    try {
      await sound.play();
      setAudioBlocked(false);
      return true;
    } catch {
      setAudioBlocked(true);
      return false;
    }
  }, []);

  const incomingCall = state.call?.status === "ringing" ? state.call : null;
  useEffect(() => {
    if (!incomingCall) {
      callAudio.current?.pause();
      return;
    }
    void playIncomingCallSound();
    const timer = window.setInterval(() => void playIncomingCallSound(), incomingCallSoundIntervalMilliseconds);
    return () => {
      window.clearInterval(timer);
      callAudio.current?.pause();
    };
  }, [incomingCall, playIncomingCallSound]);

  const value = useMemo<CommunicationsRuntimeContextValue>(() => ({
    browser,
    controller,
    lastActionError,
    permissions,
    remoteMedia,
    run,
    state,
  }), [browser, controller, lastActionError, permissions, remoteMedia, run, state]);
  const remoteAudio = useMemo(
    () => remoteMedia.filter((track) => track.mediaKind === "audio"),
    [remoteMedia],
  );

  return (
    <CommunicationsRuntimeContext.Provider value={value}>
      {children}
      {remoteAudio.length > 0 && typeof document !== "undefined" ? createPortal(
        <GlobalCommunicationsAudio tracks={remoteAudio} />,
        document.body,
      ) : null}
      {incomingCall && typeof document !== "undefined" ? createPortal(
        <IncomingCommunicationsCallNotice
          audioBlocked={audioBlocked}
          onAnswer={() => void run((activeController) => {
            if (incomingCall.kind === "meeting") return activeController.answerMeeting(incomingCall.callId);
            if (!incomingCall.invitationId) throw new Error("This call invitation is no longer available.");
            return activeController.answerCall(incomingCall.callId, incomingCall.invitationId);
          })}
          onDecline={() => void run((activeController) => {
            if (incomingCall.kind === "meeting") return activeController.dismissMeetingInvitation(incomingCall.callId);
            if (!incomingCall.invitationId) throw new Error("This call invitation is no longer available.");
            return activeController.declineCall(incomingCall.invitationId);
          })}
          onEnableSound={() => void playIncomingCallSound()}
        />,
        document.body,
      ) : null}
    </CommunicationsRuntimeContext.Provider>
  );
}

export function GlobalCommunicationsAudio({
  tracks,
}: {
  tracks: readonly CommunicationsRemoteTrack[];
}) {
  const container = useRef<HTMLDivElement | null>(null);
  const [blocked, setBlocked] = useState(false);
  const isRadio = tracks.some((track) => track.publicationKind === "ptt");
  const handleBlocked = useCallback(() => setBlocked(true), []);
  const handlePlaying = useCallback(() => setBlocked(false), []);

  const retryPlayback = useCallback(async () => {
    const elements = Array.from(container.current?.querySelectorAll("audio") ?? []);
    const results = await Promise.allSettled(elements.map((element) => element.play()));
    setBlocked(results.some((result) => result.status === "rejected"));
  }, []);

  return (
    <aside aria-live="polite" className="sphere-comms-live-audio" ref={container} role="status">
      <span aria-hidden="true"><Volume2 size={18} /></span>
      <div>
        <strong>{isRadio ? "Live team radio" : "Secure call audio"}</strong>
        <small>{blocked ? "Your browser paused audio." : isRadio ? "Listening to the selected channel" : "Audio is connected"}</small>
      </div>
      {blocked ? <button onClick={() => void retryPlayback()} type="button">Play audio</button> : null}
      {tracks.map((track) => (
        <GlobalRemoteAudio
          key={track.trackReference}
          label={track.publicationKind === "ptt" ? "Live team radio audio" : "Secure call audio"}
          onBlocked={handleBlocked}
          onPlaying={handlePlaying}
          stream={track.stream}
        />
      ))}
    </aside>
  );
}

function GlobalRemoteAudio({
  label,
  onBlocked,
  onPlaying,
  stream,
}: {
  label: string;
  onBlocked: () => void;
  onPlaying: () => void;
  stream: MediaStream;
}) {
  const element = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    const audio = element.current;
    if (!audio) return;
    audio.srcObject = stream;
    const playback = audio.play();
    if (playback && typeof playback.then === "function") {
      void playback.then(onPlaying).catch(onBlocked);
    }
    return () => {
      audio.pause();
      audio.srcObject = null;
    };
  }, [onBlocked, onPlaying, stream]);

  return <audio aria-label={label} autoPlay ref={element} />;
}

export function IncomingCommunicationsCallNotice({
  audioBlocked,
  onAnswer,
  onDecline,
  onEnableSound,
}: {
  audioBlocked: boolean;
  onAnswer: () => void;
  onDecline: () => void;
  onEnableSound: () => void;
}) {
  return (
    <aside aria-label="Incoming SygSphere call" aria-live="assertive" className="sphere-comms-incoming-toast" role="dialog">
      <span className="sphere-comms-incoming-toast__icon" aria-hidden="true"><Phone size={22} /></span>
      <div className="sphere-comms-incoming-toast__message">
        <strong>Incoming SygSphere call</strong>
        <span>Answer to join the secure call, or decline to keep working.</span>
      </div>
      {audioBlocked ? (
        <button className="sphere-comms-incoming-toast__sound" onClick={onEnableSound} type="button">
          <Volume2 size={17} /> Enable sound
        </button>
      ) : null}
      <div className="sphere-comms-incoming-toast__actions">
        <button className="is-decline" onClick={onDecline} type="button"><PhoneOff size={18} /> Decline</button>
        <button className="is-answer" onClick={onAnswer} type="button"><Phone size={18} /> Answer</button>
      </div>
    </aside>
  );
}

export function SygSphereCommunicationsWorkspace({
  conversation,
  conversations,
}: {
  conversation: SphereConversation | undefined;
  conversations: readonly SphereConversation[];
}) {
  const runtime = useCommunicationsRuntime();
  const [microphoneMuted, setMicrophoneMuted] = useState(true);
  const [pttMicrophonePrepared, setPttMicrophonePrepared] = useState(false);
  const [pttMicrophoneSetupInProgress, setPttMicrophoneSetupInProgress] = useState(false);
  const permissions = useMemo(() => new Set(runtime.permissions), [runtime.permissions]);
  const channels = useMemo(() => conversations
    .filter((item) => item.kind === "channel" && !item.archived)
    .map((item) => ({ id: item.id, label: item.name, scopeLabel: "Authorized team channel" })), [conversations]);

  const selectedChannelId = conversation?.kind === "channel"
    && channels.some((channel) => channel.id === conversation.id)
    ? conversation.id
    : "";

  useEffect(() => {
    if (runtime.state.microphoneMutedByModerator) setMicrophoneMuted(true);
    else if (!runtime.state.call || runtime.state.call.status !== "active") setMicrophoneMuted(true);
    else setMicrophoneMuted(false);
  }, [runtime.state.call, runtime.state.microphoneMutedByModerator]);

  useEffect(() => {
    setPttMicrophonePrepared(false);
    setPttMicrophoneSetupInProgress(false);
  }, [runtime.state.accountKey]);

  if (!conversation) return null;

  const capabilities: CommunicationsPanelCapabilities = {
    call: Boolean(
      conversation?.kind === "direct"
      && !conversation.archived
      && !runtime.state.call
      && permissions.has("sygsphere.comms.call.start"),
    ),
    camera: runtime.state.call?.kind === "meeting"
      && runtime.browser.cameraCapture.available
      && permissions.has("sygsphere.comms.video.publish"),
    meeting: Boolean(
      conversation
      && conversation.kind !== "direct"
      && !conversation.archived
      && !runtime.state.call
      && permissions.has("sygsphere.comms.meeting.create"),
    ),
    ptt: conversation.kind === "channel"
      && runtime.browser.audioCapture.available
      && permissions.has("sygsphere.comms.ptt.transmit")
      && !runtime.state.call
      && Boolean(selectedChannelId),
    screen: runtime.state.call?.kind === "meeting"
      && runtime.browser.screenCapture.available
      && permissions.has("sygsphere.comms.screen.publish"),
  };
  // Never leave an active-call shell mounted after the control session has
  // failed or been revoked. The reducer also tears it down, but this keeps a
  // future stale event from advertising a connected voice session.
  const call: CommunicationsPanelCall | null = runtime.state.connection === "ready"
    && runtime.state.call
    && (runtime.state.call.kind === "meeting" || runtime.state.call.status !== "ringing") ? {
    callId: runtime.state.call.callId,
    displayName: runtime.state.call.kind === "meeting" ? "Team meeting" : "Private team call",
    kind: runtime.state.call.kind,
    status: runtime.state.call.status,
  } : null;
  const pttState = communicationsPttState(runtime.state, runtime.browser.audioCapture.available);

  return (
    <div className="sphere-comms-workspace">
      <SygSphereCommunicationsPanel
        call={call}
        cameraEnabled={runtime.state.cameraActive}
        capabilities={capabilities}
        channels={channels}
        connection={runtime.state.connection}
        conversationKind={conversation.kind}
        conversationName={conversation.name}
        microphoneMuted={microphoneMuted}
        microphoneMutedByModerator={runtime.state.microphoneMutedByModerator}
        microphonePrepared={pttMicrophonePrepared}
        microphoneSetupInProgress={pttMicrophoneSetupInProgress}
        onAnswer={(callId) => void runtime.run((controller) => {
          if (runtime.state.call?.kind === "meeting" && runtime.state.call.callId === callId) return controller.answerMeeting(callId);
          const invitationId = runtime.state.call?.callId === callId ? runtime.state.call.invitationId : null;
          if (!invitationId) throw new Error("This call invitation is no longer available.");
          return controller.answerCall(callId, invitationId);
        })}
        onCameraChange={(enabled) => void runtime.run((controller) => {
          if (!runtime.state.call) return;
          return controller.setCameraEnabled(runtime.state.call.callId, enabled);
        })}
        onDecline={(callId) => void runtime.run((controller) => {
          if (runtime.state.call?.kind === "meeting" && runtime.state.call.callId === callId) return controller.dismissMeetingInvitation(callId);
          const invitationId = runtime.state.call?.callId === callId ? runtime.state.call.invitationId : null;
          if (!invitationId) throw new Error("This call invitation is no longer available.");
          return controller.declineCall(invitationId);
        })}
        onEndCall={(callId) => void runtime.run((controller) => runtime.state.call?.kind === "meeting"
          ? controller.leaveMeeting(callId)
          : controller.endCall(callId))}
        onMicrophoneMuteChange={(muted) => {
          if (!runtime.controller || !runtime.state.call || runtime.state.microphoneMutedByModerator) return;
          if (runtime.controller.setCallMicrophoneMuted(runtime.state.call.callId, muted)) setMicrophoneMuted(muted);
        }}
        onPrepareMicrophone={() => {
          if (!runtime.controller || pttMicrophoneSetupInProgress) return;
          setPttMicrophoneSetupInProgress(true);
          void runtime.run(async (controller) => {
            try {
              if (await controller.preparePttMicrophone()) setPttMicrophonePrepared(true);
            } finally {
              setPttMicrophoneSetupInProgress(false);
            }
          });
        }}
        onPttPressEnd={() => void runtime.run((controller) => controller.releaseToTalk())}
        onPttPressStart={(channelId) => void runtime.run((controller) => controller.holdToTalk(channelId))}
        onScreenShare={() => void runtime.run((controller) => {
          if (!runtime.state.call) return;
          return controller.shareScreen(runtime.state.call.callId);
        })}
        onStartCall={() => void runtime.run((controller) => {
          if (!conversation || conversation.kind !== "direct") {
            throw new Error("Choose a direct conversation before starting a call.");
          }
          return controller.startCall(conversation.id);
        })}
        onStartMeeting={() => void runtime.run((controller) => {
          if (!conversation || conversation.kind === "direct") {
            throw new Error("Choose a group or channel before starting a meeting.");
          }
          return controller.createMeeting(conversation.id);
        })}
        pttState={pttState}
        remoteMedia={runtime.remoteMedia}
        selectedChannelId={selectedChannelId}
      />
      {runtime.lastActionError || runtime.state.lastError ? (
        <div className="sphere-comms-workspace__notice" role="alert">
          <span>{runtime.lastActionError ?? publicRuntimeStateError(runtime.state.lastError)}</span>
          {runtime.state.connection === "failed" && runtime.state.accountKey ? (
            <button onClick={() => void runtime.run((controller) => controller.start(runtime.state.accountKey!))} type="button">
              Reconnect communications
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function useCommunicationsRuntime(): CommunicationsRuntimeContextValue {
  return useContext(CommunicationsRuntimeContext) ?? unavailableRuntimeContext;
}

function communicationsPttState(
  state: CommunicationsRuntimeState,
  audioCaptureAvailable: boolean,
): "permission_needed" | "ready" | "requesting" | "transmitting" | "releasing" | "reconnecting" | "denied" {
  if (!audioCaptureAvailable || ["unavailable", "denied", "failed"].includes(state.connection)) return "denied";
  if (state.connection === "authorizing" || state.connection === "connecting" || state.connection === "reconnecting") return "reconnecting";
  if (state.floor?.status === "requesting" || state.floor?.status === "preparing") return "requesting";
  if (state.floor?.status === "releasing") return "releasing";
  if (state.floor?.status === "ready" || state.floor?.status === "transmitting") return "transmitting";
  return "ready";
}

function publicCommunicationsError(error: unknown): string {
  if (error instanceof DOMException && error.name === "NotAllowedError") {
    return "Microphone, camera, or screen access was not allowed. Update the browser permission and try again.";
  }
  if (error instanceof Error && error.message && !/\b(?:token|provider|database|websocket|sdp)\b/i.test(error.message)) {
    return error.message;
  }
  return "Communications could not complete that action. Continue with messages or Dispatch and try again.";
}

function publicRuntimeStateError(error: string | null): string {
  if (!error) return "Communications could not complete that action. Continue with messages or Dispatch and try again.";
  if (["unavailable", "recipient_unavailable", "no_listener"].includes(error)) {
    return "No other authorized team member is available in this voice channel right now.";
  }
  if (["channel_busy", "floor_busy"].includes(error)) return "Someone else is speaking in this channel. Try again when they finish.";
  if (["expired", "ticket_expired", "room_expired"].includes(error)) return "The voice connection expired. Try again.";
  if (/^[a-z0-9_.-]+$/i.test(error)) return "Communications could not complete that action. Continue with messages or Dispatch and try again.";
  return error;
}
