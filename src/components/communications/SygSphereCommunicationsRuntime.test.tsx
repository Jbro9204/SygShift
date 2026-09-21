// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  authListener: null as null | ((event: string, session: { access_token: string } | null) => void),
  getSession: vi.fn(),
  getToken: null as null | (() => string | null),
  onAuthStateChange: vi.fn(),
  stateListener: null as null | ((state: unknown) => void),
  start: vi.fn(),
  stop: vi.fn(),
  unsubscribe: vi.fn(),
}));

vi.mock("../../lib/supabase", () => ({
  getSupabaseClient: () => ({
    auth: {
      getSession: runtime.getSession,
      onAuthStateChange: runtime.onAuthStateChange,
    },
  }),
}));

vi.mock("../../communications/sygsphereCommunicationsSocketBridge", () => ({
  SygSphereCommunicationsSocketBridge: class {
    constructor(getToken: () => string | null) {
      runtime.getToken = getToken;
    }
  },
}));

vi.mock("../../communications/sygsphereCommunicationsController", () => ({
  SygSphereCommunicationsController: class {
    start = runtime.start;
    stop = runtime.stop;
    subscribe = vi.fn((listener: (state: unknown) => void) => {
      runtime.stateListener = listener;
      return () => { runtime.stateListener = null; };
    });
    subscribeRemoteMedia = vi.fn(() => () => undefined);
  },
}));

vi.mock("../../communications/sygsphereCommunicationsBrowserCapabilities", () => ({
  assessCommunicationsBrowserCapabilities: () => ({
    audioCapture: { available: true, detail: "available" },
    cameraCapture: { available: true, detail: "available" },
    controlTransport: { available: true, detail: "available" },
    foregroundOnly: true,
    screenCapture: { available: true, detail: "available" },
    webRtcMedia: { available: true, detail: "available" },
  }),
  readCommunicationsBrowserEnvironment: () => ({}),
}));

import {
  GlobalCommunicationsConnectionNotice,
  GlobalCommunicationsAudio,
  IncomingCommunicationsCallNotice,
  SygSphereCommunicationsRuntimeProvider,
} from "./SygSphereCommunicationsRuntime";
import { createCommunicationsRuntimeState } from "../../communications/sygsphereCommunicationsState";

const originalMediaDevices = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
const originalSetSinkId = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "setSinkId");

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  runtime.authListener = null;
  runtime.getToken = null;
  runtime.stateListener = null;
  runtime.getSession.mockReset();
  runtime.onAuthStateChange.mockReset();
  runtime.start.mockReset();
  runtime.stop.mockReset();
  runtime.unsubscribe.mockReset();
  if (originalMediaDevices) Object.defineProperty(navigator, "mediaDevices", originalMediaDevices);
  else Reflect.deleteProperty(navigator, "mediaDevices");
  if (originalSetSinkId) Object.defineProperty(HTMLMediaElement.prototype, "setSinkId", originalSetSinkId);
  else Reflect.deleteProperty(HTMLMediaElement.prototype, "setSinkId");
});

describe("SygSphereCommunicationsRuntimeProvider", () => {
  it("uses the latest Supabase token for the long-lived Communications bridge without restarting it", async () => {
    runtime.getSession.mockResolvedValue({
      data: { session: { access_token: "initial-access-token" } },
      error: null,
    });
    runtime.onAuthStateChange.mockImplementation((listener) => {
      runtime.authListener = listener;
      return { data: { subscription: { unsubscribe: runtime.unsubscribe } } };
    });

    render(
      <SygSphereCommunicationsRuntimeProvider employeeId="employee-a" enabled permissions={[]}>
        <div>Workspace</div>
      </SygSphereCommunicationsRuntimeProvider>,
    );

    await waitFor(() => expect(runtime.start).toHaveBeenCalledWith("employee-a"));
    expect(runtime.getToken?.()).toBe("initial-access-token");

    runtime.authListener?.("TOKEN_REFRESHED", { access_token: "refreshed-access-token" });

    expect(runtime.getToken?.()).toBe("refreshed-access-token");
    expect(runtime.start).toHaveBeenCalledTimes(1);
  });

  it("keeps a failed global voice runtime visible and recoverable outside a selected conversation", async () => {
    runtime.getSession.mockResolvedValue({
      data: { session: { access_token: "initial-access-token" } },
      error: null,
    });
    runtime.onAuthStateChange.mockImplementation(() => ({
      data: { subscription: { unsubscribe: runtime.unsubscribe } },
    }));

    render(
      <SygSphereCommunicationsRuntimeProvider employeeId="employee-a" enabled permissions={[]}>
        <div>Scheduling workspace</div>
      </SygSphereCommunicationsRuntimeProvider>,
    );

    await waitFor(() => expect(runtime.start).toHaveBeenCalledWith("employee-a"));
    runtime.stateListener?.({
      ...createCommunicationsRuntimeState("employee-a"),
      connection: "failed",
      lastError: "private provider session 123",
    });

    const status = await screen.findByRole("status", { name: "SygSphere voice status" });
    expect(status).toHaveTextContent("SygSphere voice is unavailable");
    expect(status).not.toHaveTextContent("private provider session 123");
    expect(screen.getByText("Scheduling workspace")).toBeVisible();
    runtime.start.mockClear();
    fireEvent.click(screen.getByRole("button", { name: /reconnect voice/i }));
    expect(runtime.start).toHaveBeenCalledWith("employee-a");
  });
});

describe("GlobalCommunicationsConnectionNotice", () => {
  it("shows a compact passive status while a healthy session is reconnecting", () => {
    render(<GlobalCommunicationsConnectionNotice connection="reconnecting" />);

    expect(screen.getByRole("status", { name: "SygSphere voice status" })).toHaveTextContent("SygSphere voice is reconnecting");
    expect(screen.queryByRole("button", { name: /reconnect voice/i })).not.toBeInTheDocument();
  });
});

describe("IncomingCommunicationsCallNotice", () => {
  it("keeps incoming calls actionable outside the SygSphere page", () => {
    const onAnswer = vi.fn();
    const onDecline = vi.fn();
    render(
      <IncomingCommunicationsCallNotice
        audioBlocked={false}
        onAnswer={onAnswer}
        onDecline={onDecline}
        onEnableSound={vi.fn()}
      />,
    );

    expect(screen.getByRole("dialog", { name: "Incoming SygSphere call" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /answer/i }));
    fireEvent.click(screen.getByRole("button", { name: /decline/i }));
    expect(onAnswer).toHaveBeenCalledOnce();
    expect(onDecline).toHaveBeenCalledOnce();
  });

  it("offers an explicit recovery action when browser audio is blocked", () => {
    const onEnableSound = vi.fn();
    render(
      <IncomingCommunicationsCallNotice
        audioBlocked
        onAnswer={vi.fn()}
        onDecline={vi.fn()}
        onEnableSound={onEnableSound}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /enable sound/i }));
    expect(onEnableSound).toHaveBeenCalledOnce();
  });
});

describe("GlobalCommunicationsAudio", () => {
  const radioTrack = () => ({
    callId: "ptt-a",
    mediaKind: "audio" as const,
    participantConnectionId: "connection-a",
    publicationKind: "ptt" as const,
    roomId: "room-a",
    stream: {} as MediaStream,
    trackReference: "track-a",
  });

  it("plays incoming PTT audio independently of the open page", async () => {
    Object.defineProperty(HTMLMediaElement.prototype, "srcObject", { configurable: true, writable: true, value: null });
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);

    render(<GlobalCommunicationsAudio tracks={[radioTrack()]} />);

    expect(screen.getByText("Live team radio")).toBeVisible();
    expect(screen.getByLabelText("Live team radio audio")).toBeInTheDocument();
    await waitFor(() => expect(play).toHaveBeenCalled());
  });

  it("offers a one-tap recovery when browser autoplay is blocked", async () => {
    Object.defineProperty(HTMLMediaElement.prototype, "srcObject", { configurable: true, writable: true, value: null });
    const play = vi.spyOn(HTMLMediaElement.prototype, "play")
      .mockRejectedValueOnce(new DOMException("Blocked", "NotAllowedError"))
      .mockResolvedValue();
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);

    render(<GlobalCommunicationsAudio tracks={[radioTrack()]} />);
    const retry = await screen.findByRole("button", { name: /play audio/i });
    fireEvent.click(retry);
    await waitFor(() => expect(play).toHaveBeenCalledTimes(2));
  });

  it("keeps receive-audio controls compact while applying speaker, volume, and mute choices", async () => {
    Object.defineProperty(HTMLMediaElement.prototype, "srcObject", { configurable: true, writable: true, value: null });
    const setSinkId = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(HTMLMediaElement.prototype, "setSinkId", { configurable: true, value: setSinkId });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        addEventListener: vi.fn(),
        enumerateDevices: vi.fn().mockResolvedValue([
          { deviceId: "speaker-a", kind: "audiooutput", label: "Truck speaker" },
        ]),
        removeEventListener: vi.fn(),
      },
    });
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);

    render(<GlobalCommunicationsAudio tracks={[radioTrack()]} />);
    fireEvent.click(screen.getByRole("button", { name: /audio controls/i }));

    const output = await screen.findByLabelText("Speaker output");
    expect(screen.getByRole("button", { name: "Mute speaker" })).toHaveAttribute("aria-pressed", "false");
    fireEvent.change(output, { target: { value: "speaker-a" } });
    await waitFor(() => expect(setSinkId).toHaveBeenLastCalledWith("speaker-a"));

    const audio = screen.getByLabelText("Live team radio audio") as HTMLAudioElement;
    fireEvent.change(screen.getByRole("slider", { name: "Receive volume" }), { target: { value: "35" } });
    await waitFor(() => expect(audio.volume).toBeCloseTo(0.35));

    fireEvent.click(screen.getByRole("button", { name: "Mute speaker" }));
    await waitFor(() => expect(audio.muted).toBe(true));
    expect(screen.getByRole("button", { name: "Unmute speaker" })).toHaveAttribute("aria-pressed", "true");
  });

  it("keeps playback usable on browsers that cannot select a speaker", async () => {
    Object.defineProperty(HTMLMediaElement.prototype, "srcObject", { configurable: true, writable: true, value: null });
    Object.defineProperty(HTMLMediaElement.prototype, "setSinkId", { configurable: true, value: undefined });
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);

    render(<GlobalCommunicationsAudio tracks={[radioTrack()]} />);
    fireEvent.click(screen.getByRole("button", { name: /audio controls/i }));

    expect(screen.getByText("This browser uses your device's default speaker.")).toBeVisible();
    expect(screen.queryByLabelText("Speaker output")).not.toBeInTheDocument();
  });
});
