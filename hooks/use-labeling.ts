"use client";

import { useQuery } from "@tanstack/react-query";
import {
  readShipmentError,
  ShipmentApiError,
} from "@/hooks/use-inbound-shipments";
import { labelingKeys } from "@/hooks/use-labeling-keys";
import type {
  LabelingQueueOrder,
  SupplyOrderLineView,
} from "@/lib/supply-orders/queries";

/**
 * THE LABELING QUEUE'S READ (contract pack C5.1).
 *
 * A read and nothing else. The two writes the queue performs — stocking a batch
 * and writing off a remainder — are `useStockIn` / `useDiscardRemaining` in
 * `hooks/use-supply-orders.ts`, and they stay there because the bookingKey
 * discipline (S22) is a contract between ONE client attempt and ONE server row:
 * a second home for it would be a second opinion about when a key is still live.
 *
 * The query key comes from `hooks/use-labeling-keys.ts`, which is also what
 * every supply-order mutation invalidates — so a verify in another tab moves
 * this list without either module importing the other's hooks.
 *
 * A failed read THROWS rather than resolving to an empty queue: "nothing to
 * label" is an instruction to go and do something else, and giving it because a
 * request did not land is the same lie the Orders list refuses to tell (W25-3).
 */

export type LabelingQueueGroup = {
  order: LabelingQueueOrder;
  lines: SupplyOrderLineView[];
};

/** The GET envelope (amendment 4d): the bounded page plus its truthful count. */
export interface LabelingQueueResult {
  groups: LabelingQueueGroup[];
  /** Every line the filter matched — not the number of rows returned. */
  count: number;
  /** `count - LABELING_QUEUE_LIMIT`, floored at 0: what the bound left out. */
  moreCount: number;
}

function queueUrl(orderId?: string): string {
  return orderId
    ? `/api/labeling/queue?orderId=${encodeURIComponent(orderId)}`
    : "/api/labeling/queue";
}

/** The whole queue, or the one order a "Label now" link deep-linked to. */
export function useLabelingQueue(orderId?: string) {
  return useQuery<LabelingQueueResult, ShipmentApiError>({
    queryKey: labelingKeys.queue(orderId),
    queryFn: async ({ signal }) => {
      const res = await fetch(queueUrl(orderId), { signal });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw readShipmentError(res, json, "Failed to load the labeling queue");
      return json as LabelingQueueResult;
    },
  });
}
