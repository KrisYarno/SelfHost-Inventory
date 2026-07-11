"use client";

import * as React from 'react';
import { Check, Copy } from 'lucide-react';
import { formatDateTime, formatShortDateTime } from '@/lib/utils';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { StatusBadge } from '@/components/ui/status-badge';
import { ValueChip } from '@/components/ui/value-chip';

export interface TransferLogRow {
  id: number;
  createdAt: string | Date;
  productName: string;
  quantity: number | null;
  fromLocationName: string;
  toLocationName: string;
  userName: string;
  batchId?: string | null;
  transferId?: string | null;
}

interface TransferLogTableProps {
  logs: TransferLogRow[];
}

/** A monospace id truncated with a copy-to-clipboard affordance. */
function CopyableId({ value, label = "Copy id" }: { value: string; label?: string }) {
  const [copied, setCopied] = React.useState(false);
  const short = value.length > 10 ? `${value.slice(0, 8)}…` : value;
  return (
    <button
      type="button"
      title={value}
      aria-label={label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        } catch {
          /* clipboard unavailable — no-op */
        }
      }}
      className="inline-flex items-center gap-1 rounded-sm font-mono text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="tabular-nums">{short}</span>
      {copied ? (
        <Check className="h-3 w-3 text-positive-foreground" aria-hidden />
      ) : (
        <Copy className="h-3 w-3" aria-hidden />
      )}
    </button>
  );
}

export function TransferLogTable({ logs }: TransferLogTableProps) {
  if (!logs.length) {
    return (
      <Card className="mt-4">
        <CardHeader>
          <CardTitle>Transfers</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          No transfer activity recorded yet.
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="mt-4">
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle>Transfers</CardTitle>
        <StatusBadge tone="info" className="bg-muted text-foreground border-border/70">
          Latest {logs.length}
        </StatusBadge>
      </CardHeader>
      <CardContent>
        {/* Mobile cards */}
        <div className="space-y-3 md:hidden">
          {logs.map((log) => {
            const qty = log.quantity ?? 0;
            return (
              <div
                key={log.id}
                className="rounded-xl border border-border/60 bg-surface px-4 py-3 text-sm shadow-sm transition hover:shadow-md"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="font-medium leading-tight line-clamp-1">{log.productName}</div>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {formatShortDateTime(log.createdAt)}
                  </span>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <StatusBadge tone="info">Transfer</StatusBadge>
                  <ValueChip tone="neutral" className="bg-muted/70 text-foreground border-border/70">
                    {qty} units
                  </ValueChip>
                  {log.batchId && (
                    <StatusBadge tone="neutral" className="bg-muted text-muted-foreground border-border/60">
                      Batch
                    </StatusBadge>
                  )}
                </div>
                <div className="mt-2 text-xs font-medium">
                  <span className="text-negative">{log.fromLocationName}</span>
                  <span className="mx-2 text-muted-foreground" aria-hidden>→</span>
                  <span className="text-positive">{log.toLocationName}</span>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span>by {log.userName}</span>
                  {log.transferId && (
                    <>
                      <span aria-hidden>·</span>
                      <CopyableId value={log.transferId} label="Copy transfer id" />
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Desktop table */}
        <div className="hidden md:block">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date / Time</TableHead>
                <TableHead>Product</TableHead>
                <TableHead>From</TableHead>
                <TableHead>To</TableHead>
                <TableHead className="text-right">Quantity</TableHead>
                <TableHead>Transfer ID</TableHead>
                <TableHead>User</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {logs.map((log) => {
                const qty = log.quantity ?? 0;
                return (
                  <TableRow key={log.id}>
                    <TableCell className="tabular-nums">{formatDateTime(log.createdAt)}</TableCell>
                    <TableCell>
                      <span className="block max-w-[28ch] truncate" title={log.productName}>{log.productName}</span>
                    </TableCell>
                    <TableCell className="text-negative">{log.fromLocationName}</TableCell>
                    <TableCell className="text-positive">{log.toLocationName}</TableCell>
                    <TableCell className="text-right">
                      <span className="font-medium tabular-nums">{qty}</span>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        {log.transferId ? (
                          <CopyableId value={log.transferId} label="Copy transfer id" />
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                        {log.batchId && (
                          <StatusBadge tone="neutral" className="bg-muted text-muted-foreground border-border/60">
                            Batch
                          </StatusBadge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>{log.userName}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}
