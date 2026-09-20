// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GlobalCommunicationsAudio, IncomingCommunicationsCallNotice } from "./SygSphereCommunicationsRuntime";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
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
});
