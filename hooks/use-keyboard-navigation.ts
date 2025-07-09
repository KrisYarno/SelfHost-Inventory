"use client";

import { useEffect, useRef, useState } from "react";

interface UseKeyboardNavigationOptions {
  itemsPerRow?: number;
  onEnter?: (index: number) => void;
  onSpace?: (index: number) => void;
  onEscape?: () => void;
}

export function useKeyboardNavigation(
  itemCount: number,
  options: UseKeyboardNavigationOptions = {}
) {
  const { itemsPerRow = 1, onEnter, onSpace, onEscape } = options;
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!containerRef.current?.contains(document.activeElement)) return;

      let newIndex = focusedIndex;
      let handled = false;

      switch (e.key) {
        case "ArrowDown":
          newIndex = Math.min(focusedIndex + itemsPerRow, itemCount - 1);
          handled = true;
          break;
        case "ArrowUp":
          newIndex = Math.max(focusedIndex - itemsPerRow, 0);
          handled = true;
          break;
        case "ArrowRight":
          if (focusedIndex < itemCount - 1) {
            newIndex = focusedIndex + 1;
            handled = true;
          }
          break;
        case "ArrowLeft":
          if (focusedIndex > 0) {
            newIndex = focusedIndex - 1;
            handled = true;
          }
          break;
        case "Home":
          newIndex = 0;
          handled = true;
          break;
        case "End":
          newIndex = itemCount - 1;
          handled = true;
          break;
        case "Enter":
          if (onEnter && focusedIndex >= 0) {
            onEnter(focusedIndex);
            handled = true;
          }
          break;
        case " ":
        case "Space":
          if (onSpace && focusedIndex >= 0) {
            e.preventDefault();
            onSpace(focusedIndex);
            handled = true;
          }
          break;
        case "Escape":
          if (onEscape) {
            onEscape();
            handled = true;
          }
          break;
      }

      if (handled) {
        e.preventDefault();
        if (newIndex !== focusedIndex && newIndex >= 0 && newIndex < itemCount) {
          setFocusedIndex(newIndex);
          
          // Focus the element at the new index
          const items = containerRef.current?.querySelectorAll('[data-keyboard-nav-item]');
          if (items && items[newIndex]) {
            (items[newIndex] as HTMLElement).focus();
          }
        }
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [focusedIndex, itemCount, itemsPerRow, onEnter, onSpace, onEscape]);

  const handleItemFocus = (index: number) => {
    setFocusedIndex(index);
  };

  const getItemProps = (index: number) => ({
    'data-keyboard-nav-item': true,
    'data-index': index,
    tabIndex: index === focusedIndex ? 0 : -1,
    onFocus: () => handleItemFocus(index),
  });

  return {
    containerRef,
    focusedIndex,
    getItemProps,
  };
}