/** @jest-environment jsdom */
/**
 * /labeling — the THIN server page (contract pack C5.2).
 *
 * It owns exactly one decision, and it is the kind that goes wrong silently: a
 * URL may carry `orderId` twice, and Next hands a repeated key over as an ARRAY.
 * Passing that array on would put an array in the react-query key and `a,b` in
 * the request, so the page normalizes to ONE string — and an empty value is no
 * filter at all rather than a filter on "".
 */

import * as React from "react";
import { render, screen } from "@testing-library/react";

jest.mock("@/components/labeling/labeling-queue", () => ({
  LabelingQueue: ({ orderId }: { orderId?: string }) => (
    <div data-testid="labeling-queue" data-order-id={orderId === undefined ? "none" : orderId} />
  ),
}));

import LabelingPage from "@/app/(app)/labeling/page";

const ORDER_A = "cksupply000000000000000001";

it("passes no filter when the URL names no order", () => {
  render(<LabelingPage />);
  expect(screen.getByTestId("labeling-queue")).toHaveAttribute("data-order-id", "none");
});

it("passes the single order the URL names", () => {
  render(<LabelingPage searchParams={{ orderId: ORDER_A }} />);
  expect(screen.getByTestId("labeling-queue")).toHaveAttribute("data-order-id", ORDER_A);
});

it("normalizes a REPEATED key to the first value, never an array", () => {
  render(<LabelingPage searchParams={{ orderId: [ORDER_A, "cksupply000000000000000002"] }} />);
  expect(screen.getByTestId("labeling-queue")).toHaveAttribute("data-order-id", ORDER_A);
});

it("treats an empty value as no filter", () => {
  render(<LabelingPage searchParams={{ orderId: "   " }} />);
  expect(screen.getByTestId("labeling-queue")).toHaveAttribute("data-order-id", "none");
});
