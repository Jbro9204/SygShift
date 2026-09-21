// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GlobalCommunicationsAudio, IncomingCommunicationsCallNotice } from "./SygSphereCommunicationsRuntime";

const originalMediaDevices = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
const originalSetSinkId = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "setSinkId");

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  if (originalMediaDevices) Object.defineProperty(navigator, "mediaDevices", originalMediaDevices);
  else Reflect.deleteProperty(navigator, "mediaDevices");
  if (originalSetSinkId) Object.defineProperty(HTMLMediaElement.prototype, "setSinkId", originalSetSinkId);
  else Reflect.deleteProperty(HTMLMediaElement.prototype, "setSinkId");
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
