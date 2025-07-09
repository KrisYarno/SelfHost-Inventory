"use client";

import { useEffect, useRef } from "react";

/**
 * Hook to announce messages to screen readers using ARIA live regions
 * @param message - The message to announce
 * @param priority - The priority level: "polite" (default) or "assertive"
 */
export function useAccessibilityAnnouncer() {
  const announcerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    // Create the announcer element if it doesn't exist
    if (!announcerRef.current) {
      const announcer = document.createElement("div");
      announcer.setAttribute("aria-live", "polite");
      announcer.setAttribute("aria-atomic", "true");
      announcer.setAttribute("role", "status");
      announcer.className = "sr-only";
      document.body.appendChild(announcer);
      announcerRef.current = announcer;
    }

    return () => {
      // Cleanup on unmount
      if (announcerRef.current && document.body.contains(announcerRef.current)) {
        document.body.removeChild(announcerRef.current);
        announcerRef.current = null;
      }
    };
  }, []);

  const announce = (message: string, priority: "polite" | "assertive" = "polite") => {
    if (!announcerRef.current) return;

    // Update the priority if needed
    if (announcerRef.current.getAttribute("aria-live") !== priority) {
      announcerRef.current.setAttribute("aria-live", priority);
    }

    // Clear the content first to ensure the announcement is made
    announcerRef.current.textContent = "";
    
    // Use a small delay to ensure the screen reader picks up the change
    setTimeout(() => {
      if (announcerRef.current) {
        announcerRef.current.textContent = message;
      }
    }, 100);
  };

  return { announce };
}

/**
 * Hook to announce inventory changes to screen readers
 */
export function useInventoryChangeAnnouncer() {
  const { announce } = useAccessibilityAnnouncer();

  const announceChange = (productName: string, change: number, newTotal: number) => {
    if (change === 0) return;

    const changeText = change > 0 
      ? `increased by ${change}` 
      : `decreased by ${Math.abs(change)}`;
    
    const message = `${productName} ${changeText}. New quantity will be ${newTotal}.`;
    announce(message);
  };

  const announceBatchSubmission = (productCount: number, netChange: number) => {
    const message = `Submitting ${productCount} adjustments with a net change of ${netChange > 0 ? '+' : ''}${netChange} units.`;
    announce(message, "assertive");
  };

  const announceSubmissionResult = (success: boolean, details?: string) => {
    if (success) {
      announce(`Adjustments submitted successfully. ${details || ''}`, "assertive");
    } else {
      announce(`Failed to submit adjustments. ${details || 'Please try again.'}`, "assertive");
    }
  };

  return {
    announceChange,
    announceBatchSubmission,
    announceSubmissionResult,
  };
}