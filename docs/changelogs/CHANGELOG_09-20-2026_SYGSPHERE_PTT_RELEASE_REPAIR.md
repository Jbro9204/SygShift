# SygSphere PTT release repair — September 20, 2026

## Issue corrected

Production acceptance identified a real release-state defect: after a user released the push-to-talk control, the transmitting browser could remain visually in the talking state. The floor server closed the transmission, but its end event was sent only to listeners and not to the requester. A missed pointer-release event could compound the problem on some browser/device combinations.

## Repair

- The server now emits the authoritative `transmission.ended` event to the requester as well as every authorized listener.
- The browser clears local PTT state immediately on release, stops local microphone focus, and will not create an overlapping floor request while one is active.
- Window-level pointer and touch end/cancel listeners backstop the control-level release handler, including when a pointer ends outside the button or capture is unavailable.
- The presentation layer no longer represents a release transition as an active transmission.

## Verification

- Targeted PTT controller, state, and UI checks passed: **36 tests**.
- Full communications QA passed: **18 test files / 111 tests**, covering PTT, calls, meetings, media, recovery, the provider boundary, and stage gates.
- SygShift typecheck, lint, and production build passed.
- Sygilant lint and full test suite passed: **192 test files / 905 tests**.
- The live Sygilant SygSphere workspace loads the authorized PTT Acceptance Test channel in Ready state.

## Safety preserved

This repair does not broaden any role, channel, or media access. The server still derives members and listeners from the authorized channel, keeps the microphone muted until readiness is confirmed, and closes media on release or lease expiry.
