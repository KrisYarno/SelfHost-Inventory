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
  const getLogTypeColor = (logType: string) => {
    switch (logType) {
      case 'ADJUSTMENT':
        return 'default';
      case 'TRANSFER':
        return 'secondary';
      default:
        return 'outline';
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
                {showUser && <TableHead>User</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {logs.length === 0 ? (
                <TableRow>
                  <TableCell 
                    colSpan={5 + (showProduct ? 1 : 0) + (showLocation ? 1 : 0) + (showUser ? 1 : 0)} 
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
                        {log.logType}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      {log.delta > 0 ? '+' : ''}{log.delta}
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