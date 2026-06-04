"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import AddProductSearch, { type ScratchProduct } from "./add-product-search";
import ProductScratchCard from "./product-scratch-card";
import type { Row } from "./scratch-row";

interface BoardProduct {
  id: number;
  name: string;
  baseName?: string | null;
  variant?: string | null;
  scratchpadPrices: Row[];
}

export default function ScratchpadBoard() {
  const [board, setBoard] = useState<BoardProduct[]>([]);
  // Products added via search that have no persisted row yet (local-only until the first POST).
  const [localCards, setLocalCards] = useState<BoardProduct[]>([]);
  const [labels, setLabels] = useState<string[]>([]);
  // Set true while any inline editor / unsaved local card is open, to pause the poll (P6).
  const editingRef = useRef(false);

  const loadBoard = useCallback(async () => {
    if (editingRef.current) return; // don't clobber in-progress local state (P6)
    const res = await fetch("/api/scratchpad");
    if (res.ok) setBoard((await res.json()).board);
  }, []);

  const loadLabels = useCallback(async () => {
    const res = await fetch("/api/scratchpad/labels");
    if (res.ok) setLabels((await res.json()).labels ?? []);
  }, []);

  useEffect(() => {
    loadBoard();
    loadLabels();
  }, [loadBoard, loadLabels]);

  useEffect(() => {
    const onFocus = () => loadBoard();
    const id = setInterval(loadBoard, 30_000);
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(id);
      window.removeEventListener("focus", onFocus);
    };
  }, [loadBoard]);

  // Once a product has persisted rows it appears in `board`; drop its local placeholder.
  const persistedIds = new Set(board.map((p) => p.id));
  const cards: BoardProduct[] = [
    ...localCards.filter((c) => !persistedIds.has(c.id)),
    ...board,
  ];

  // After any change: refetch board + labels, and clear the editing flag so polling resumes.
  const handleChanged = useCallback(() => {
    editingRef.current = false;
    loadBoard();
    loadLabels();
  }, [loadBoard, loadLabels]);

  const handleAdd = useCallback((product: ScratchProduct) => {
    editingRef.current = true; // hold the poll until the first row is saved
    setLocalCards((c) => [{ ...product, scratchpadPrices: [] }, ...c]);
  }, []);

  return (
    <div className="space-y-4">
      <AddProductSearch
        onAdd={handleAdd}
        existingIds={new Set(cards.map((c) => c.id))}
      />
      {cards.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No rough prices yet — add a product to start.
        </p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {cards.map((p) => (
            <ProductScratchCard
              key={p.id}
              product={p}
              labels={labels}
              onActivity={(active: boolean) => {
                editingRef.current = active;
              }}
              onChanged={handleChanged}
            />
          ))}
        </div>
      )}
    </div>
  );
}
