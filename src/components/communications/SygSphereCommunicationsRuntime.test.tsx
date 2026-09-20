// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { IncomingCommunicationsCallNotice } from "./SygSphereCommunicationsRuntime";

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
