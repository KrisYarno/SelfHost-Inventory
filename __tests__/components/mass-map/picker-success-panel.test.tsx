/**
 * @jest-environment jsdom
 *
 * REGRESSION GUARD: D5 — `onKeep` was previously in the timer effect's deps,
 * so a fresh callback identity from the parent restarted the timer every
 * render and the 8s auto-keep never fired. This test verifies that even with
 * inline-arrow callbacks (which produce a new identity on every render), the
 * timer still elapses and onKeep is invoked exactly once.
 */
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { PickerSuccessPanel } from "@/components/products/mass-map/picker-success-panel";

jest.useFakeTimers();

function Harness({ onFinish, onKeep }: { onFinish: jest.Mock; onKeep: jest.Mock }) {
  // Force re-renders to simulate parent updates that previously broke the timer.
  const [counter, setCounter] = useState(0);
  return (
    <>
      <button onClick={() => setCounter((c) => c + 1)}>tick {counter}</button>
      <PickerSuccessPanel
        parentTitle="Coffee Beans"
        variantTitle="5 lb"
        internalProductName="Coffee Beans 5 lb"
        autoKeepAfterMs={8000}
        onFinish={() => onFinish()}
        onKeep={() => onKeep()}
      />
    </>
  );
}

describe("PickerSuccessPanel", () => {
  it("fires onKeep after 8s even when parent re-renders with fresh callbacks", () => {
    const onFinish = jest.fn();
    const onKeep = jest.fn();
    render(<Harness onFinish={onFinish} onKeep={onKeep} />);

    // Force several re-renders before the timer would naturally fire
    act(() => { jest.advanceTimersByTime(2000); });
    act(() => { screen.getByText(/^tick/).click(); });
    act(() => { jest.advanceTimersByTime(2000); });
    act(() => { screen.getByText(/^tick/).click(); });
    act(() => { jest.advanceTimersByTime(2000); });
    act(() => { screen.getByText(/^tick/).click(); });

    expect(onKeep).not.toHaveBeenCalled();

    act(() => { jest.advanceTimersByTime(3000); });
    expect(onKeep).toHaveBeenCalledTimes(1);
    expect(onFinish).not.toHaveBeenCalled();
  });

  it("calls onFinish when the Finished button is clicked", async () => {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    const onFinish = jest.fn();
    const onKeep = jest.fn();
    render(
      <PickerSuccessPanel
        parentTitle="Coffee Beans"
        variantTitle="5 lb"
        internalProductName="Coffee Beans 5 lb"
        onFinish={onFinish}
        onKeep={onKeep}
      />,
    );
    await user.click(screen.getByRole("button", { name: /Finished mapping/i }));
    expect(onFinish).toHaveBeenCalled();
    expect(onKeep).not.toHaveBeenCalled();
  });

  it("calls onKeep when the Keep mapping button is clicked", async () => {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    const onFinish = jest.fn();
    const onKeep = jest.fn();
    render(
      <PickerSuccessPanel
        parentTitle="Coffee Beans"
        variantTitle="5 lb"
        internalProductName="Coffee Beans 5 lb"
        onFinish={onFinish}
        onKeep={onKeep}
      />,
    );
    await user.click(screen.getByRole("button", { name: /Keep mapping/i }));
    expect(onKeep).toHaveBeenCalled();
  });
});
