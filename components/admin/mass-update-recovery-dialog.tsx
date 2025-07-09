"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  AlertTriangle,
  RefreshCw,
  X,
  AlertCircle,
  Database,
  Network,
  HelpCircle,
  Package,
  MapPin
} from "lucide-react";
import { FailedUpdate, UpdateFailureReason } from "@/types/mass-update-errors";
import { cn } from "@/lib/utils";

interface MassUpdateRecoveryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  failures: FailedUpdate[];
  onRetry: (failures: FailedUpdate[]) => void;
  onDismiss: () => void;
  isRetrying?: boolean;
}

const failureReasonConfig: Record<UpdateFailureReason, {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  color: string;
  description: string;
}> = {
  VALIDATION_ERROR: {
    label: "Validation Error",
    icon: AlertCircle,
    color: "text-red-600",
    description: "The data provided is invalid"
  },
  INSUFFICIENT_STOCK: {
    label: "Insufficient Stock",
    icon: Package,
    color: "text-orange-600",
    description: "Not enough stock available"
  },
  PRODUCT_NOT_FOUND: {
    label: "Product Not Found",
    icon: Package,
    color: "text-red-600",
    description: "Product does not exist or was deleted"
  },
  LOCATION_NOT_FOUND: {
    label: "Location Not Found",
    icon: MapPin,
    color: "text-red-600",
    description: "Location does not exist"
  },
  CONCURRENT_UPDATE: {
    label: "Concurrent Update",
    icon: RefreshCw,
    color: "text-yellow-600",
    description: "Another user modified this data"
  },
  DATABASE_ERROR: {
    label: "Database Error",
    icon: Database,
    color: "text-red-600",
    description: "Database operation failed"
  },
  NETWORK_ERROR: {
    label: "Network Error",
    icon: Network,
    color: "text-gray-600",
    description: "Connection to server failed"
  },
  UNKNOWN_ERROR: {
    label: "Unknown Error",
    icon: HelpCircle,
    color: "text-gray-600",
    description: "An unexpected error occurred"
  }
};

export function MassUpdateRecoveryDialog({
  open,
  onOpenChange,
  failures,
  onRetry,
  onDismiss,
  isRetrying = false
}: MassUpdateRecoveryDialogProps) {
  const [selectedFailures, setSelectedFailures] = useState<Set<string>>(
    new Set(failures.filter(f => f.canRetry).map(f => `${f.productId}-${f.locationId}`))
  );

  const retryableFailures = failures.filter(f => f.canRetry);
  const permanentFailures = failures.filter(f => !f.canRetry);

  const handleToggleFailure = (key: string) => {
    const newSelected = new Set(selectedFailures);
    if (newSelected.has(key)) {
      newSelected.delete(key);
    } else {
      newSelected.add(key);
    }
    setSelectedFailures(newSelected);
  };

  const handleRetry = () => {
    const failuresToRetry = failures.filter(f => 
      selectedFailures.has(`${f.productId}-${f.locationId}`)
    );
    onRetry(failuresToRetry);
  };

  const groupedFailures = failures.reduce((acc, failure) => {
    if (!acc[failure.reason]) {
      acc[failure.reason] = [];
    }
    acc[failure.reason].push(failure);
    return acc;
  }, {} as Record<UpdateFailureReason, FailedUpdate[]>);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[80vh]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-orange-600" />
            Inventory Update Issues
          </DialogTitle>
          <DialogDescription>
            {failures.length} update{failures.length !== 1 ? 's' : ''} could not be completed.
            {retryableFailures.length > 0 && ' You can retry the failed updates below.'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {permanentFailures.length > 0 && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>
                {permanentFailures.length} update{permanentFailures.length !== 1 ? 's' : ''} cannot be retried due to validation errors.
              </AlertDescription>
            </Alert>
          )}

          <ScrollArea className="h-[400px] rounded-md border">
            <div className="p-4 space-y-6">
              {Object.entries(groupedFailures).map(([reason, reasonFailures]) => {
                const config = failureReasonConfig[reason as UpdateFailureReason];
                const Icon = config.icon;
                
                return (
                  <div key={reason} className="space-y-3">
                    <div className="flex items-center gap-2">
                      <Icon className={cn("h-4 w-4", config.color)} />
                      <h4 className="font-medium">{config.label}</h4>
                      <Badge variant="secondary" className="ml-auto">
                        {reasonFailures.length}
                      </Badge>
                    </div>
                    <p className="text-sm text-muted-foreground">
                      {config.description}
                    </p>
                    
                    <div className="space-y-2">
                      {reasonFailures.map((failure) => {
                        const key = `${failure.productId}-${failure.locationId}`;
                        const isSelected = selectedFailures.has(key);
                        
                        return (
                          <div
                            key={key}
                            className={cn(
                              "flex items-start gap-3 p-3 rounded-lg border",
                              failure.canRetry && "cursor-pointer hover:bg-muted/50",
                              !failure.canRetry && "opacity-60"
                            )}
                            onClick={() => failure.canRetry && handleToggleFailure(key)}
                          >
                            {failure.canRetry && (
                              <input
                                type="checkbox"
                                checked={isSelected}
                                onChange={() => handleToggleFailure(key)}
                                className="mt-1"
                                onClick={(e) => e.stopPropagation()}
                              />
                            )}
                            
                            <div className="flex-1 space-y-1">
                              <div className="flex items-center gap-2">
                                <span className="font-medium">{failure.productName}</span>
                                <span className="text-muted-foreground">at</span>
                                <span className="font-medium">{failure.locationName}</span>
                              </div>
                              
                              <div className="flex items-center gap-4 text-sm text-muted-foreground">
                                <span>Attempted: {failure.attemptedQuantity}</span>
                                <span>Current: {failure.currentQuantity}</span>
                                <span>Change: {failure.attemptedQuantity - failure.currentQuantity > 0 ? '+' : ''}{failure.attemptedQuantity - failure.currentQuantity}</span>
                              </div>
                              
                              <p className="text-sm text-muted-foreground">
                                {failure.message}
                              </p>
                            </div>
                            
                            {!failure.canRetry && (
                              <Badge variant="secondary" className="mt-1">
                                Cannot Retry
                              </Badge>
                            )}
                          </div>
                        );
                      })}
                    </div>
                    
                    {reason !== Object.keys(groupedFailures)[Object.keys(groupedFailures).length - 1] && (
                      <Separator className="mt-4" />
                    )}
                  </div>
                );
              })}
            </div>
          </ScrollArea>
        </div>

        <DialogFooter className="flex-col sm:flex-row gap-2">
          <div className="flex-1 text-sm text-muted-foreground">
            {selectedFailures.size > 0 && (
              <span>{selectedFailures.size} item{selectedFailures.size !== 1 ? 's' : ''} selected for retry</span>
            )}
          </div>
          <Button
            variant="outline"
            onClick={onDismiss}
            disabled={isRetrying}
          >
            Dismiss All
          </Button>
          {retryableFailures.length > 0 && (
            <Button
              onClick={handleRetry}
              disabled={selectedFailures.size === 0 || isRetrying}
            >
              {isRetrying ? (
                <>
                  <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                  Retrying...
                </>
              ) : (
                <>
                  <RefreshCw className="mr-2 h-4 w-4" />
                  Retry Selected ({selectedFailures.size})
                </>
              )}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}