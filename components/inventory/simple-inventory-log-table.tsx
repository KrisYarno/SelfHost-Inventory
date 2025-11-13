'use client';

import React from 'react';
import { format } from 'date-fns';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { StatusBadge, type StatusBadgeProps } from '@/components/ui/status-badge';
import { ValueChip } from '@/components/ui/value-chip';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { inventory_logs, Product, Location, User } from '@prisma/client';

type SimpleInventoryLog = inventory_logs & {
  users: User;
  products: Product;
  locations: Location | null;
};

interface SimpleInventoryLogTableProps {
  logs: SimpleInventoryLog[];
  title?: string;
  showProduct?: boolean;
  showLocation?: boolean;
  showUser?: boolean;
}

export function SimpleInventoryLogTable({
  logs,
  title = 'Inventory Log',
  showProduct = true,
  showLocation = true,
  showUser = true,
}: SimpleInventoryLogTableProps) {
  // Group transfer pairs (one negative, one positive) into a single row
  type TransferRow = { kind: 'transfer'; from: SimpleInventoryLog; to: SimpleInventoryLog };
  type NormalRow = { kind: 'normal'; log: SimpleInventoryLog };
  type LogRow = TransferRow | NormalRow;

  const groupTransferLogs = (input: SimpleInventoryLog[]): LogRow[] => {
    const rows: LogRow[] = [];
    const used = new Set<number>();
    const MAX_SECONDS_DIFF = 5; // pair within 5 seconds

    for (let i = 0; i < input.length; i++) {
      if (used.has(i)) continue;
      const log = input[i];

      if (log.logType === 'TRANSFER') {
        // Try to find counterpart
        let pairedIndex = -1;
        for (let j = i + 1; j < input.length; j++) {
          if (used.has(j)) continue;
          const other = input[j];
          if (other.logType !== 'TRANSFER') continue;
          if (other.productId !== log.productId) continue;
          if (other.userId !== log.userId) continue;

          const t1 = log.changeTime ? new Date(log.changeTime).getTime() : 0;
          const t2 = other.changeTime ? new Date(other.changeTime).getTime() : 0;
          const dt = Math.abs(t1 - t2) / 1000;
          if (dt > MAX_SECONDS_DIFF) continue;

          // Opposite deltas with same magnitude
          if (log.delta + other.delta !== 0) continue;

          pairedIndex = j;
          break;
        }

        if (pairedIndex >= 0) {
          used.add(i);
          used.add(pairedIndex);
          const a = input[i];
          const b = input[pairedIndex];
          const from = a.delta < 0 ? a : b;
          const to = a.delta > 0 ? a : b;
          rows.push({ kind: 'transfer', from, to });
          continue;
        }
      }

      // Fallback: normal row
      used.add(i);
      rows.push({ kind: 'normal', log });
    }

    return rows;
  };

  const groupedRows = groupTransferLogs(logs);
  const getLogTone = (logType: string): StatusBadgeProps['tone'] => {
    switch (logType) {
      case 'TRANSFER':
        return 'info';
      case 'STOCK_IN':
        return 'positive';
      case 'STOCK_OUT':
        return 'negative';
      case 'ADJUSTMENT':
        return 'neutral';
      default:
        return 'neutral';
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className="px-0 sm:px-6">
        {/* Mobile View */}
        <div className="sm:hidden">
          {groupedRows.length === 0 ? (
            <p className="text-center text-muted-foreground py-8 px-6">
              No inventory logs found
            </p>
          ) : (
            <div className="space-y-3">
              {groupedRows.map((row) => {
                if (row.kind === 'transfer') {
                  const { from, to } = row;
                  const qty = Math.abs(from.delta);
                  return (
                    <div key={`transfer-${from.id}-${to.id}`} className="px-6 py-3 border-b last:border-b-0 space-y-2">
                      <div className="flex justify-between items-start">
                        <div className="space-y-1">
                          {showProduct && <p className="font-medium text-sm">{from.products.name}</p>}
                          <div className="flex items-center gap-2 text-xs text-muted-foreground">
                            {from.changeTime && <span>{format(new Date(from.changeTime), 'MMM dd, HH:mm')}</span>}
                            {showLocation && (
                              <>
                                <span>•</span>
                                <span>
                                  <span className="text-red-600">{from.locations?.name || '-'}</span>
                                  <span className="mx-1">-&gt;</span>
                                  <span className="text-emerald-600">{to.locations?.name || '-'}</span>
                                </span>
                              </>
                            )}
                          </div>
                        </div>
                      <div className="text-right space-y-1">
                        <div className="flex flex-wrap justify-end gap-1">
                          <ValueChip tone="negative">-{qty}</ValueChip>
                          <ValueChip tone="positive">+{qty}</ValueChip>
                        </div>
                        <StatusBadge tone="info">Transfer</StatusBadge>
                      </div>
                      </div>
                      {showUser && <p className="text-xs text-muted-foreground">by {from.users.username}</p>}
                    </div>
                  );
                }

                const log = row.log;
                return (
                  <div key={log.id} className="px-6 py-3 border-b last:border-b-0 space-y-2">
                    <div className="flex justify-between items-start">
                      <div className="space-y-1">
                        {showProduct && <p className="font-medium text-sm">{log.products.name}</p>}
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          {log.changeTime && <span>{format(new Date(log.changeTime), 'MMM dd, HH:mm')}</span>}
                          {showLocation && log.locations && (
                            <>
                              <span>•</span>
                              <span>{log.locations.name}</span>
                            </>
                          )}
                        </div>
                      </div>
                      <div className="text-right space-y-1">
                        <ValueChip
                          tone={log.delta > 0 ? 'positive' : log.delta < 0 ? 'negative' : 'neutral'}
                        >
                          {log.delta > 0 ? '+' : ''}{log.delta}
                        </ValueChip>
                        <StatusBadge tone={getLogTone(log.logType)}>{log.logType}</StatusBadge>
                      </div>
                    </div>
                    {showUser && <p className="text-xs text-muted-foreground">by {log.users.username}</p>}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Desktop View */}
        <div className="hidden sm:block overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date/Time</TableHead>
                {showProduct && <TableHead>Product</TableHead>}
                {showLocation && <TableHead>Location</TableHead>}
                <TableHead>Type</TableHead>
                <TableHead className="text-right">Change</TableHead>
                {showUser && <TableHead>User</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {groupedRows.length === 0 ? (
                <TableRow>
                  <TableCell 
                    colSpan={5 + (showProduct ? 1 : 0) + (showLocation ? 1 : 0) + (showUser ? 1 : 0)} 
                    className="text-center text-muted-foreground py-8"
                  >
                    No inventory logs found
                  </TableCell>
                </TableRow>
              ) : (
                groupedRows.map((row) => {
                  if (row.kind === 'transfer') {
                    const { from, to } = row;
                    const qty = Math.abs(from.delta);
                    return (
                      <TableRow key={`transfer-${from.id}-${to.id}`}>
                        <TableCell className="whitespace-nowrap">
                          {from.changeTime ? format(new Date(from.changeTime), 'MMM dd, yyyy HH:mm') : '-'}
                        </TableCell>
                        {showProduct && (
                          <TableCell className="font-medium">{from.products.name}</TableCell>
                        )}
                        {showLocation && (
                          <TableCell>
                            <span className="text-red-600">{from.locations?.name || '-'}</span>
                            <span className="mx-1">-&gt;</span>
                            <span className="text-emerald-600">{to.locations?.name || '-'}</span>
                          </TableCell>
                        )}
                        <TableCell>
                          <StatusBadge tone="info">Transfer</StatusBadge>
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex items-center justify-end gap-2">
                            <ValueChip tone="negative">-{qty}</ValueChip>
                            <ValueChip tone="positive">+{qty}</ValueChip>
                          </div>
                        </TableCell>
                        {showUser && <TableCell>{from.users.username}</TableCell>}
                      </TableRow>
                    );
                  }
                  const log = row.log;
                  return (
                    <TableRow key={log.id}>
                      <TableCell className="whitespace-nowrap">
                        {log.changeTime ? format(new Date(log.changeTime), 'MMM dd, yyyy HH:mm') : '-'}
                      </TableCell>
                      {showProduct && <TableCell className="font-medium">{log.products.name}</TableCell>}
                      {showLocation && <TableCell>{log.locations?.name || '-'}</TableCell>}
                      <TableCell>
                        <StatusBadge tone={getLogTone(log.logType)}>{log.logType}</StatusBadge>
                      </TableCell>
                      <TableCell className="text-right">
                        <ValueChip tone={log.delta > 0 ? 'positive' : log.delta < 0 ? 'negative' : 'neutral'}>
                          {log.delta > 0 ? '+' : ''}{log.delta}
                        </ValueChip>
                      </TableCell>
                      {showUser && <TableCell>{log.users.username}</TableCell>}
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}
