'use client';

import { useQuery } from '@tanstack/react-query';
import { queryKeys, CACHE_TIMES } from '@/lib/cache-config';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { formatDistanceToNow } from 'date-fns';
import type { CurrentInventoryLevel } from '@/types/inventory';

interface InventoryTableOptimizedProps {
  locationId?: number;
  onProductClick?: (productId: number) => void;
}

export function InventoryTableOptimized({ 
  locationId, 
  onProductClick 
}: InventoryTableOptimizedProps) {
  // Use the optimized endpoint with React Query caching
  const { data, isLoading, error, isFetching } = useQuery({
    queryKey: queryKeys.inventory.current(locationId),
    queryFn: async () => {
      const params = locationId ? `?locationId=${locationId}` : '';
      const response = await fetch(`/api/inventory/current-optimized${params}`);
      
      if (!response.ok) {
        throw new Error('Failed to fetch inventory');
      }
      
      return response.json();
    },
    staleTime: CACHE_TIMES.INVENTORY,
    gcTime: CACHE_TIMES.INVENTORY * 2,
    refetchInterval: CACHE_TIMES.INVENTORY, // Auto-refresh every 5 minutes
  });

  if (isLoading) {
    return <InventoryTableSkeleton />;
  }

  if (error) {
    return (
      <Card className="p-6">
        <p className="text-destructive">
          Failed to load inventory: {error.message}
        </p>
      </Card>
    );
  }

  const inventory = data?.inventory || [];

  return (
    <Card>
      <div className="relative">
        {isFetching && (
          <div className="absolute top-2 right-2">
            <Badge variant="secondary" className="animate-pulse">
              Updating...
            </Badge>
          </div>
        )}
        
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Product</TableHead>
              <TableHead>Variant</TableHead>
              <TableHead>Location</TableHead>
              <TableHead className="text-right">Quantity</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Last Updated</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {inventory.map((item: CurrentInventoryLevel) => (
              <TableRow 
                key={`${item.productId}-${item.locationId}`}
                className="cursor-pointer hover:bg-muted/50"
                onClick={() => onProductClick?.(item.productId)}
              >
                <TableCell className="font-medium">
                  {item.product.baseName || item.product.name}
                </TableCell>
                <TableCell>
                  {item.product.variant || '-'}
                </TableCell>
                <TableCell>
                  {item.location.name}
                </TableCell>
                <TableCell className="text-right">
                  {item.quantity}
                </TableCell>
                <TableCell>
                  <StockStatusBadge 
                    quantity={item.quantity} 
                    threshold={item.product.lowStockThreshold}
                  />
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {item.lastUpdated && new Date(item.lastUpdated).getTime() > 0
                    ? formatDistanceToNow(new Date(item.lastUpdated), { addSuffix: true })
                    : 'Never'
                  }
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        
        {inventory.length === 0 && (
          <div className="p-8 text-center text-muted-foreground">
            No inventory data available
          </div>
        )}
      </div>
    </Card>
  );
}

function StockStatusBadge({ quantity, threshold }: { quantity: number; threshold: number }) {
  if (quantity === 0) {
    return <Badge variant="destructive">Out of Stock</Badge>;
  }
  
  if (quantity < threshold) {
    return <Badge variant="outline" className="border-orange-500 text-orange-600">Low Stock</Badge>;
  }
  
  return <Badge variant="outline" className="border-green-500 text-green-600">In Stock</Badge>;
}

function InventoryTableSkeleton() {
  return (
    <Card>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Product</TableHead>
            <TableHead>Variant</TableHead>
            <TableHead>Location</TableHead>
            <TableHead className="text-right">Quantity</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Last Updated</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {Array.from({ length: 5 }).map((_, i) => (
            <TableRow key={i}>
              <TableCell><Skeleton className="h-4 w-32" /></TableCell>
              <TableCell><Skeleton className="h-4 w-24" /></TableCell>
              <TableCell><Skeleton className="h-4 w-20" /></TableCell>
              <TableCell><Skeleton className="h-4 w-12 ml-auto" /></TableCell>
              <TableCell><Skeleton className="h-4 w-20" /></TableCell>
              <TableCell><Skeleton className="h-4 w-28" /></TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  );
}