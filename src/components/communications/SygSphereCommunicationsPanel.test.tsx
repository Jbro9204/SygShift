// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SygSphereCommunicationsPanel } from "./SygSphereCommunicationsPanel";

afterEach(cleanup);

const actions = () => ({
  onAnswer: vi.fn(),
  onCameraChange: vi.fn(),
  onChannelChange: vi.fn(),
  onDecline: vi.fn(),
  onEndCall: vi.fn(),
  onMicrophoneMuteChange: vi.fn(),
  onPttPressEnd: vi.fn(),
  onPttPressStart: vi.fn(),
  onScreenShare: vi.fn(),
  onStartCall: vi.fn(),
  onStartMeeting: vi.fn(),
});

const base = () => ({
  ...actions(),
  call: null,
  cameraEnabled: false,
  capabilities: { call: true, camera: true, meeting: true, ptt: true, screen: true },
  channels: [{ id: "dispatch", label: "Dispatch", scopeLabel: "Your Dispatch channel" }],
  connection: "ready" as const,
  microphoneMuted: false,
  microphoneMutedByModerator: false,
  pttState: "ready" as const,
  selectedChannelId: "dispatch",
});

describe("SygSphere communications panel", () => {
  it("makes the primary Guard workflow explicit", () => {
    render(<SygSphereCommunicationsPanel {...base()} />);
    expect(screen.getByRole("button", { name: /hold to talk/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: /call a coworker/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: /start a meeting/i })).toBeEnabled();
    expect(screen.getByText(/camera and screen sharing are always off/i)).toBeVisible();
  });

  it("starts on press and releases on pointer release", () => {
    const props = base();
    render(<SygSphereCommunicationsPanel {...props} />);
    const button = screen.getByRole("button", { name: /hold to talk/i });
    fireEvent.pointerDown(button, { button: 0, pointerId: 1 });
    expect(props.onPttPressStart).toHaveBeenCalledWith("dispatch");
    fireEvent.pointerUp(button, { pointerId: 1 });
    expect(props.onPttPressEnd).toHaveBeenCalledTimes(1);
  });

  it("releases when the pointer ends outside the control", () => {
    const props = base();
    render(<SygSphereCommunicationsPanel {...props} />);
    const button = screen.getByRole("button", { name: /hold to talk/i });
    fireEvent.pointerDown(button, { button: 0, pointerId: 1 });
    fireEvent.pointerUp(window, { pointerId: 1 });
    expect(props.onPttPressEnd).toHaveBeenCalledTimes(1);
  });

  it("shows a distinct, non-transmitting state while the release is confirmed", () => {
    render(<SygSphereCommunicationsPanel {...base()} pttState="releasing" />);
    const button = screen.getByRole("button", { name: /releasing/i });
    expect(button).toBeDisabled();
    expect(button).not.toHaveClass("is-transmitting");
  });

  it("supports keyboard hold and release without repeated starts", () => {
    const props = base();
    render(<SygSphereCommunicationsPanel {...props} />);
    const button = screen.getByRole("button", { name: /hold to talk/i });
    fireEvent.keyDown(button, { key: " ", repeat: false });
    fireEvent.keyDown(button, { key: " ", repeat: true });
    fireEvent.keyUp(button, { key: " " });
    expect(props.onPttPressStart).toHaveBeenCalledTimes(1);
    expect(props.onPttPressEnd).toHaveBeenCalledTimes(1);
  });

  it("shows clear incoming call actions", () => {
    const props = base();
    render(<SygSphereCommunicationsPanel {...props} call={{ callId: "call-a", displayName: "Dispatch", kind: "direct", status: "ringing" }} />);
    fireEvent.click(screen.getByRole("button", { name: /answer/i }));
    fireEvent.click(screen.getByRole("button", { name: /decline/i }));
    expect(props.onAnswer).toHaveBeenCalledWith("call-a");
    expect(props.onDecline).toHaveBeenCalledWith("call-a");
  });

  it("disables controls that the server did not authorize", () => {
    render(<SygSphereCommunicationsPanel {...base()} capabilities={{ call: false, camera: false, meeting: false, ptt: false, screen: false }} />);
    expect(screen.getByRole("button", { name: /hold to talk/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /call a coworker/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /start a meeting/i })).toBeDisabled();
  });

  it("shows a clear voice state instead of an empty black media area", () => {
    render(<SygSphereCommunicationsPanel
      {...base()}
      call={{ callId: "call-a", displayName: "Dispatch", kind: "direct", status: "active" }}
    />);
    expect(screen.getByText("Voice call connected")).toBeVisible();
    expect(screen.getByText(/camera and screen sharing remain off/i)).toBeVisible();
  });

  it("prioritizes an authorized shared screen in the active call stage", () => {
    const sharedScreen = {} as MediaStream;
    render(<SygSphereCommunicationsPanel
      {...base()}
      call={{ callId: "call-a", displayName: "Operations", kind: "meeting", status: "active" }}
      remoteMedia={[{
        callId: "call-a",
        mediaKind: "screen",
        participantConnectionId: "d285bf11-15f6-4efe-b60f-4ab891637342",
        publicationKind: "screen",
        roomId: "room-a",
        stream: sharedScreen,
        trackReference: "screen-a",
      }]}
    />);
    expect(screen.getByLabelText("Shared screen")).toHaveClass("is-featured");
    expect(screen.queryByText("Voice call connected")).not.toBeInTheDocument();
  });
});
