"use client";

import { useRef, useState } from "react";
import { cn } from "@/lib/utils";

interface SwipeableAdjustmentProps {
  onSwipeLeft?: () => void;
  onSwipeRight?: () => void;
  children: React.ReactNode;
  className?: string;
  role?: string;
  'aria-label'?: string;
  tabIndex?: number;
}

export function SwipeableAdjustment({
  onSwipeLeft,
  onSwipeRight,
  children,
  className,
  role,
  'aria-label': ariaLabel,
  tabIndex,
}: SwipeableAdjustmentProps) {
  const startXRef = useRef<number | null>(null);
  const startYRef = useRef<number | null>(null);
  const [lastX, setLastX] = useState<number | null>(null);
  const [swiping, setSwiping] = useState(false);
  const [swipeDistance, setSwipeDistance] = useState(0);

  // Swipe sensitivity tuning
  // - Require more horizontal distance
  // - Only act if horizontal dominates vertical
  const minSwipeDistance = 80; // px
  const minStartThreshold = 12; // px before we consider entering swipe state

  const onTouchStart = (e: React.TouchEvent) => {
    const t = e.targetTouches[0];
    startXRef.current = t.clientX;
    startYRef.current = t.clientY;
    setLastX(t.clientX);
    setSwiping(false); // don't enter swiping until we confirm horizontal intent
    setSwipeDistance(0);
  };

  const onTouchMove = (e: React.TouchEvent) => {
    const startX = startXRef.current;
    const startY = startYRef.current;
    if (startX == null || startY == null) return;

    const t = e.targetTouches[0];
    const dx = t.clientX - startX;
    const dy = t.clientY - startY;

    // If vertical movement dominates, treat as scroll and never enter swiping
    if (!swiping) {
      if (Math.abs(dy) > Math.abs(dx)) {
        return; // let page scroll
      }
      // Require a small horizontal threshold before engaging swiping visuals
      if (Math.abs(dx) < minStartThreshold) {
        return;
      }
      setSwiping(true);
    }

    setLastX(t.clientX);
    setSwipeDistance(dx);
  };

  const onTouchEnd = () => {
    const startX = startXRef.current;
    if (startX == null || lastX == null) {
      startXRef.current = null;
      startYRef.current = null;
      setSwiping(false);
      setSwipeDistance(0);
      return;
    }

    const distance = lastX - startX;
    const isLeftSwipe = distance < -minSwipeDistance;
    const isRightSwipe = distance > minSwipeDistance;

    if (isLeftSwipe && onSwipeLeft) {
      onSwipeLeft();
    }
    
    if (isRightSwipe && onSwipeRight) {
      onSwipeRight();
    }

    // Reset
    startXRef.current = null;
    startYRef.current = null;
    setSwiping(false);
    setSwipeDistance(0);
  };

  // Keyboard navigation support
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowLeft' && onSwipeLeft) {
      e.preventDefault();
      onSwipeLeft();
    } else if (e.key === 'ArrowRight' && onSwipeRight) {
      e.preventDefault();
      onSwipeRight();
    }
  };

  return (
    <div
      className={cn(
        "relative overflow-x-visible overflow-y-hidden touch-pan-y focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-primary",
        className
      )}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onKeyDown={handleKeyDown}
      role={role}
      aria-label={ariaLabel}
      tabIndex={tabIndex}
    >
      {/* Swipe indicators */}
      {swiping && (
        <>
          {swipeDistance > 0 && (
            <div 
              className="absolute inset-y-0 left-0 bg-green-500/20 flex items-center px-4"
              style={{ width: Math.min(swipeDistance, 100) }}
              aria-hidden="true"
            >
              <span className="text-green-600 font-medium">+1</span>
            </div>
          )}
          {swipeDistance < 0 && (
            <div 
              className="absolute inset-y-0 right-0 bg-red-500/20 flex items-center justify-end px-4"
              style={{ width: Math.min(Math.abs(swipeDistance), 100) }}
              aria-hidden="true"
            >
              <span className="text-red-600 font-medium">-1</span>
            </div>
          )}
        </>
      )}
      
      {/* Content */}
      <div
        className={cn(
          "relative transition-transform",
          swiping && "transition-none"
        )}
        style={{
          transform: swiping ? `translateX(${swipeDistance * 0.3}px)` : "translateX(0)",
        }}
      >
        {children}
      </div>
    </div>
  );
}
