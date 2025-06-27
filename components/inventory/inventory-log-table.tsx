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
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { InventoryLogWithRelations } from '@/types/inventory';
import { inventory_logs_logType } from '@prisma/client';

interface InventoryLogTableProps {
  logs: InventoryLogWithRelations[];
  title?: string;
  showProduct?: boolean;
  showLocation?: boolean;
  showUser?: boolean;
}

export function InventoryLogTable({
  logs,
  title = 'Inventory Log',
  showProduct = true,
  showLocation = true,
  showUser = true,
}: InventoryLogTableProps) {
  const getLogTypeColor = (logType: inventory_logs_logType) => {
    switch (logType) {
      case 'ADJUSTMENT':
        return 'default';
      case 'TRANSFER':
        return 'secondary';
      default:
        return 'outline';
    }
  };

  const getLogTypeLabel = (logType: inventory_logs_logType) => {
    switch (logType) {
      case 'ADJUSTMENT':
        return 'Adjustment';
      case 'TRANSFER':
        return 'Transfer';
      default:
        return logType;
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date/Time</TableHead>
                {showProduct && <TableHead>Product</TableHead>}
                {showLocation && <TableHead>Location</TableHead>}
                <TableHead>Type</TableHead>
                <TableHead className="text-right">Change</TableHead>
                <TableHead className="text-right">Before</TableHead>
                <TableHead className="text-right">After</TableHead>
                {showUser && <TableHead>User</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {logs.length === 0 ? (
                <TableRow>
                  <TableCell 
                    colSpan={10} 
                    className="text-center text-muted-foreground py-8"
                  >
                    No inventory logs found
                  </TableCell>
                </TableRow>
              ) : (
                logs.map((log) => (
                  <TableRow key={log.id}>
                    <TableCell className="whitespace-nowrap">
                      {log.changeTime ? format(new Date(log.changeTime), 'MMM dd, yyyy HH:mm') : '-'}
                    </TableCell>
                    {showProduct && (
                      <TableCell className="font-medium">
                        {log.products.name}
                      </TableCell>
                    )}
                    {showLocation && (
                      <TableCell>{log.locations?.name || '-'}</TableCell>
                    )}
                    <TableCell>
                      <Badge variant={getLogTypeColor(log.logType)}>
                        {getLogTypeLabel(log.logType)}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      {log.delta > 0 ? '+' : ''}{log.delta}
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      -
                    </TableCell>
                    <TableCell className="text-right font-mono font-semibold">
                      -
                    </TableCell>
                    {showUser && (
                      <TableCell>{log.users.username}</TableCell>
                    )}
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}