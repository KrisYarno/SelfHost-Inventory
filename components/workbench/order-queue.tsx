"use client";

import { useState } from "react";
import { useWorkbench } from "@/hooks/use-workbench";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ChevronDown, ChevronUp, ListOrdered, Plus, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

export function OrderQueue() {
  const [isExpanded, setIsExpanded] = useState(true);
  const [inputValue, setInputValue] = useState("");

  const {
    orderQueue,
    orderReference,
    addToQueue,
    removeFromQueue,
    clearQueue,
    getQueuePosition,
  } = useWorkbench();

  const queuePosition = getQueuePosition();
  const totalInQueue = orderQueue.length;

  const handleAdd = () => {
    const trimmed = inputValue.trim();
    if (!trimmed) return;
    addToQueue(trimmed);
    setInputValue("");
    toast.success(`Added "${trimmed}" to queue`);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleAdd();
    }
  };

  const handleClearQueue = () => {
    if (totalInQueue === 0) return;
    if (confirm("Clear all queued orders?")) {
      clearQueue();
      toast.info("Queue cleared");
    }
  };

  return (
    <div className="border-b bg-background">
      {/* Collapsible Header */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center justify-between p-4 hover:bg-muted/50 transition-colors"
      >
        <div className="flex items-center gap-2">
          <ListOrdered className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">Order Queue</span>
          {totalInQueue > 0 && (
            <Badge variant="secondary" className="text-xs">
              {totalInQueue} queued
            </Badge>
          )}
          {queuePosition && (
            <Badge variant="default" className="text-xs">
              Order {queuePosition.current} of {queuePosition.total}
            </Badge>
          )}
        </div>
        {isExpanded ? (
          <ChevronUp className="h-4 w-4 text-muted-foreground" />
        ) : (
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        )}
      </button>

      {/* Collapsible Content */}
      <div
        className={cn(
          "overflow-hidden transition-all duration-200",
          isExpanded ? "max-h-80" : "max-h-0"
        )}
      >
        <div className="px-4 pb-4 space-y-3">
          {/* Add to Queue Input */}
          <div className="flex gap-2">
            <Input
              placeholder="Order reference..."
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={handleKeyDown}
              className="font-mono text-sm"
            />
            <Button
              size="sm"
              variant="outline"
              onClick={handleAdd}
              disabled={!inputValue.trim()}
            >
              <Plus className="h-4 w-4 mr-1" />
              Add
            </Button>
          </div>

          {/* Current Order Indicator */}
          {orderReference.trim() && (
            <div className="flex items-center gap-2 text-sm">
              <span className="text-muted-foreground">Now packing:</span>
              <span className="font-mono font-medium">{orderReference}</span>
            </div>
          )}

          {/* Queue List */}
          {totalInQueue > 0 && (
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground uppercase tracking-wider">
                  Up next
                </span>
                <button
                  onClick={handleClearQueue}
                  className="text-xs text-muted-foreground hover:text-destructive transition-colors"
                >
                  Clear all
                </button>
              </div>
              <ul className="space-y-1 max-h-32 overflow-y-auto">
                {orderQueue.map((ref, index) => (
                  <li
                    key={`${ref}-${index}`}
                    className="flex items-center justify-between rounded-md bg-muted/50 px-3 py-1.5 group"
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground tabular-nums w-5">
                        {index + 1}.
                      </span>
                      <span className="font-mono text-sm">{ref}</span>
                    </div>
                    <button
                      onClick={() => removeFromQueue(index)}
                      className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity text-muted-foreground hover:text-destructive"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Empty State */}
          {totalInQueue === 0 && !orderReference.trim() && (
            <p className="text-xs text-muted-foreground text-center py-2">
              Add order references to process them sequentially
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
