export type CommunicationsBrowserCapability = Readonly<{
  available: boolean;
  detail: string;
}>;

export type CommunicationsBrowserCapabilities = Readonly<{
  audioCapture: CommunicationsBrowserCapability;
  cameraCapture: CommunicationsBrowserCapability;
  controlTransport: CommunicationsBrowserCapability;
  foregroundOnly: true;
  screenCapture: CommunicationsBrowserCapability;
  webRtcMedia: CommunicationsBrowserCapability;
}>;

export type CommunicationsBrowserEnvironment = Readonly<{
  hasDisplayMedia: boolean;
  hasGetUserMedia: boolean;
  hasPeerConnection: boolean;
  hasWebSocket: boolean;
  secureContext: boolean;
}>;

export function readCommunicationsBrowserEnvironment(): CommunicationsBrowserEnvironment {
  return {
    hasDisplayMedia: typeof navigator !== "undefined" && typeof navigator.mediaDevices?.getDisplayMedia === "function",
    hasGetUserMedia: typeof navigator !== "undefined" && typeof navigator.mediaDevices?.getUserMedia === "function",
    hasPeerConnection: typeof RTCPeerConnection === "function",
    hasWebSocket: typeof WebSocket === "function",
    secureContext: typeof window !== "undefined" && window.isSecureContext,
  };
}

export function assessCommunicationsBrowserCapabilities(
  environment: CommunicationsBrowserEnvironment,
): CommunicationsBrowserCapabilities {
  const secure = environment.secureContext;
  const control = secure && environment.hasWebSocket;
  const webRtc = secure && environment.hasPeerConnection;
  const capture = secure && environment.hasGetUserMedia;
  return {
    audioCapture: capability(capture, secure ? "Microphone capture API available; permission is still required." : "A secure HTTPS page is required for microphone access."),
    cameraCapture: capability(capture, secure ? "Camera capture API available; a camera and permission are still required." : "A secure HTTPS page is required for camera access."),
    controlTransport: capability(control, !secure ? "A secure HTTPS page is required." : "This browser does not provide the required WebSocket control transport."),
    foregroundOnly: true,
    screenCapture: capability(secure && environment.hasDisplayMedia, !secure ? "A secure HTTPS page is required for screen sharing." : "This browser can view shared screens but cannot start screen capture."),
    webRtcMedia: capability(webRtc, !secure ? "A secure HTTPS page is required for voice and video." : "This browser does not provide the required WebRTC media transport."),
  };
}

function capability(available: boolean, detail: string): CommunicationsBrowserCapability {
  return { available, detail };
}
