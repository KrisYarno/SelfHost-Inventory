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
      <CardContent className="px-0 sm:px-6">
        {/* Mobile View */}
        <div className="sm:hidden">
          {logs.length === 0 ? (
            <p className="text-center text-muted-foreground py-8 px-6">
              No inventory logs found
            </p>
          ) : (
            <div className="space-y-3">
              {logs.map((log) => (
                <div 
                  key={log.id} 
                  className="px-6 py-3 border-b last:border-b-0 space-y-2"
                >
                  <div className="flex justify-between items-start">
                    <div className="space-y-1">
                      {showProduct && (
                        <p className="font-medium text-sm">{log.products.name}</p>
                      )}
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        {log.changeTime && (
                          <span>{format(new Date(log.changeTime), 'MMM dd, HH:mm')}</span>
                        )}
                        {showLocation && log.locations && (
                          <>
                            <span>•</span>
                            <span>{log.locations.name}</span>
                          </>
                        )}
                      </div>
                    </div>
                    <div className="text-right space-y-1">
                      <p className={`font-mono font-semibold ${log.delta > 0 ? 'text-green-600' : 'text-red-600'}`}>
                        {log.delta > 0 ? '+' : ''}{log.delta}
                      </p>
                      <Badge variant={getLogTypeColor(log.logType)} className="text-xs">
                        {log.logType}
                      </Badge>
                    </div>
                  </div>
                  {showUser && (
                    <p className="text-xs text-muted-foreground">by {log.users.username}</p>
                  )}
                </div>
              ))}
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
                      <span className={log.delta > 0 ? 'text-green-600' : 'text-red-600'}>
                        {log.delta > 0 ? '+' : ''}{log.delta}
                      </span>
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