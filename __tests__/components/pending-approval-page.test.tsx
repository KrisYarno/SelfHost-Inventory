/**
 * @jest-environment jsdom
 *
 * N0 C5 (RC-14) — the pending-approval page makes no promise the product cannot
 * keep: no approval email exists, so "You will receive an email notification once
 * your account has been approved" is gone. The page is otherwise unchanged (C5
 * deliberately does NOT surface the server's error text: a real pending user has no
 * session, so it would read "Unauthorized").
 */
import { render, screen } from "@testing-library/react";

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), prefetch: jest.fn() }),
}));

import PendingApprovalPage from "@/app/auth/pending-approval/page";

it("no longer promises an approval email", () => {
  render(<PendingApprovalPage />);
  expect(screen.queryByText(/receive an email notification/i)).not.toBeInTheDocument();
  expect(document.body.textContent).not.toMatch(/once your account has been approved/i);
});

it("keeps the true pending-approval copy and the Notify button", () => {
  render(<PendingApprovalPage />);
  expect(
    screen.getByText(/Your account is currently pending approval from an administrator\./)
  ).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Notify an administrator" })).toBeInTheDocument();
});
