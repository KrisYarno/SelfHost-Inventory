/** @jest-environment jsdom */
//
// Facelift FR3-5 (plan 2026-11-18-facelift-f1 REV 11; QA-4) — THE ADMIN REJECT
// DIALOG COVERS THE DOCK.
//
// Before: the card's Reject overlay was a `fixed inset-0 z-50` div rendered in
// place, inside the shell's `<main>` — the same stacking level as the phone
// dock, which sat on top of it: the dock stayed live under an open "Reject
// User Application" dialog, and its tabs navigated away mid-decision. Now the
// overlay is portaled to `document.body` at `z-[60]` (FR2-5's pattern), above
// the dock, and its Cancel and Confirm Rejection work as before.

import * as React from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UserApprovalCard } from "@/components/admin/user-approval-card";

const USER = { id: 7, email: "ada@example.test", username: "ada", isAdmin: false, isApproved: false };

function renderCard() {
  const onApprove = jest.fn(async () => {});
  const onReject = jest.fn(async () => {});
  render(
    <main>
      <UserApprovalCard user={USER} onApprove={onApprove} onReject={onReject} />
    </main>
  );
  return { onApprove, onReject };
}

/** The overlay: the full-screen layer holding the dialog's heading. */
const overlay = () =>
  screen.getByRole("heading", { name: "Reject User Application" }).closest(".fixed") as HTMLElement;

describe("FR3-5 — the admin Reject dialog covers the dock", () => {
  it("is a child of document.body (not of main), at z-[60]", async () => {
    const user = userEvent.setup();
    renderCard();
    await user.click(screen.getByRole("button", { name: "Reject" }));

    const layer = overlay();
    expect(layer).not.toBeNull();
    expect(layer.parentElement).toBe(document.body);
    expect(screen.getByRole("main")).not.toContainElement(layer);
    expect(layer).toHaveClass("fixed", "inset-0", "z-[60]");
    expect(layer).not.toHaveClass("z-50");
  });

  it("Cancel closes it, rejects nothing, and clears the reason", async () => {
    const user = userEvent.setup();
    const { onReject } = renderCard();
    await user.click(screen.getByRole("button", { name: "Reject" }));
    await user.type(screen.getByLabelText("Reason (optional)"), "dup");

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("heading", { name: "Reject User Application" })).toBeNull();
    expect(onReject).not.toHaveBeenCalled();

    // Reopened, the reason is gone.
    await user.click(screen.getByRole("button", { name: "Reject" }));
    expect(screen.getByLabelText("Reason (optional)")).toHaveValue("");
  });

  it("Confirm Rejection rejects the user with the reason, then closes", async () => {
    const user = userEvent.setup();
    const { onReject } = renderCard();
    await user.click(screen.getByRole("button", { name: "Reject" }));
    await user.type(screen.getByLabelText("Reason (optional)"), "Not a customer");

    await act(async () => {
      await user.click(screen.getByRole("button", { name: "Confirm Rejection" }));
    });
    expect(onReject).toHaveBeenCalledTimes(1);
    expect(onReject).toHaveBeenCalledWith(7, "Not a customer");
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Reject User Application" })).toBeNull());
  });
});
