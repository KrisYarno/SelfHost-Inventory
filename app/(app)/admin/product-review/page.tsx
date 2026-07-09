"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, XCircle, ClipboardCheck, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useCSRF, withCSRFHeaders } from "@/hooks/use-csrf";
import type { FetchError } from "@/hooks/use-integrations";

interface PendingProduct {
  id: number;
  name: string;
  approvalStatus: string;
  currentQuantity: number;
  createdByUser?: { id: number; username: string; email: string } | null;
}

export default function ProductReviewPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { token: csrfToken } = useCSRF();

  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [pendingId, setPendingId] = useState<number | null>(null);
  const [bulkLoading, setBulkLoading] = useState(false);

  const productsQuery = useQuery<PendingProduct[], FetchError>({
    queryKey: ["pending-products"],
    queryFn: async () => {
      const response = await fetch(
        "/api/admin/products?approvalStatus=PENDING_REVIEW"
      );
      if (!response.ok) {
        const err = new Error("Failed to fetch products") as FetchError;
        err.status = response.status;
        throw err;
      }
      const data = await response.json();
      return (data.products ?? []) as PendingProduct[];
    },
  });

  const products = productsQuery.data ?? [];
  const loading = productsQuery.isFetching;

  // Refetch the pending list and clear selection (mirrors the original fetchProducts).
  const refresh = () => {
    setSelected(new Set());
    queryClient.invalidateQueries({ queryKey: ["pending-products"] });
  };

  // Redirect on auth failure; toast other load errors (mirrors the original fetchProducts catch).
  useEffect(() => {
    const err = productsQuery.error;
    if (!err) return;
    if (err.status === 401) {
      router.push("/auth/signin");
    } else {
      console.error("Error fetching pending products:", err);
      toast.error("Failed to load products");
    }
  }, [productsQuery.error, router]);

  const approveOne = async (id: number): Promise<boolean> => {
    const response = await fetch(`/api/admin/products/${id}/approve`, {
      method: "POST",
      headers: withCSRFHeaders({}, csrfToken),
    });
    return response.ok;
  };

  const declineOne = async (id: number): Promise<boolean> => {
    const response = await fetch(`/api/admin/products/${id}/decline`, {
      method: "POST",
      headers: withCSRFHeaders({}, csrfToken),
    });
    return response.ok;
  };

  const handleApprove = async (id: number) => {
    setPendingId(id);
    try {
      const ok = await approveOne(id);
      if (!ok) throw new Error("Failed to approve product");
      toast.success("Product approved");
      refresh();
    } catch (error) {
      console.error("Error approving product:", error);
      toast.error("Failed to approve product");
    } finally {
      setPendingId(null);
    }
  };

  const handleDecline = async (id: number) => {
    if (
      !confirm(
        "Decline this product? Outstanding stock will be reversed and the product soft-deleted."
      )
    ) {
      return;
    }
    setPendingId(id);
    try {
      const ok = await declineOne(id);
      if (!ok) throw new Error("Failed to decline product");
      toast.success("Product declined");
      refresh();
    } catch (error) {
      console.error("Error declining product:", error);
      toast.error("Failed to decline product");
    } finally {
      setPendingId(null);
    }
  };

  const handleBulkApprove = async () => {
    if (selected.size === 0) {
      toast.error("No products selected");
      return;
    }
    setBulkLoading(true);
    try {
      const ids = Array.from(selected);
      const results = await Promise.all(ids.map((id) => approveOne(id)));
      const ok = results.filter(Boolean).length;
      toast.success(`Approved ${ok} of ${ids.length} products`);
      refresh();
    } catch (error) {
      console.error("Error bulk approving products:", error);
      toast.error("Failed to approve products");
    } finally {
      setBulkLoading(false);
    }
  };

  const handleBulkDecline = async () => {
    if (selected.size === 0) {
      toast.error("No products selected");
      return;
    }
    if (
      !confirm(
        `Decline ${selected.size} products? Outstanding stock will be reversed and each product soft-deleted.`
      )
    ) {
      return;
    }
    setBulkLoading(true);
    try {
      const ids = Array.from(selected);
      const results = await Promise.all(ids.map((id) => declineOne(id)));
      const ok = results.filter(Boolean).length;
      toast.success(`Declined ${ok} of ${ids.length} products`);
      refresh();
    } catch (error) {
      console.error("Error bulk declining products:", error);
      toast.error("Failed to decline products");
    } finally {
      setBulkLoading(false);
    }
  };

  const toggleSelection = (id: number) => {
    const next = new Set(selected);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    setSelected(next);
  };

  const toggleSelectAll = () => {
    if (selected.size === products.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(products.map((p) => p.id)));
    }
  };

  return (
    <div className="flex flex-col h-full overflow-x-hidden">
      <div className="container mx-auto p-4 sm:p-6 space-y-6 min-w-0">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 min-w-0">
          <div>
            <h1 className="flex items-center gap-2 text-3xl font-bold">
              <ClipboardCheck className="h-7 w-7" />
              Product Review
            </h1>
            <p className="text-sm text-muted-foreground">
              Approve or decline provisional products created by non-admin users.
            </p>
          </div>
          {selected.size > 0 && (
            <div className="flex gap-2 flex-wrap">
              <Button
                onClick={handleBulkApprove}
                disabled={bulkLoading}
                variant="default"
              >
                <CheckCircle2 className="mr-2 h-4 w-4" />
                Approve {selected.size}
              </Button>
              <Button
                onClick={handleBulkDecline}
                disabled={bulkLoading}
                variant="destructive"
              >
                <XCircle className="mr-2 h-4 w-4" />
                Decline {selected.size}
              </Button>
            </div>
          )}
        </div>

        {/* Pending products */}
        <Card>
          <CardHeader>
            <CardTitle>
              Pending Review {!loading && `(${products.length})`}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="flex items-center justify-center py-12 text-muted-foreground">
                <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                Loading products…
              </div>
            ) : products.length === 0 ? (
              <div className="py-12 text-center text-sm text-muted-foreground">
                No products awaiting review.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-10">
                        <Checkbox
                          checked={
                            products.length > 0 &&
                            selected.size === products.length
                          }
                          onCheckedChange={toggleSelectAll}
                          aria-label="Select all"
                        />
                      </TableHead>
                      <TableHead>Product</TableHead>
                      <TableHead>Created by</TableHead>
                      <TableHead className="text-right">Quantity</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {products.map((product) => {
                      const isPending = pendingId === product.id;
                      return (
                        <TableRow key={product.id}>
                          <TableCell>
                            <Checkbox
                              checked={selected.has(product.id)}
                              onCheckedChange={() =>
                                toggleSelection(product.id)
                              }
                              aria-label={`Select ${product.name}`}
                            />
                          </TableCell>
                          <TableCell className="font-medium">
                            {product.name}
                          </TableCell>
                          <TableCell>
                            {product.createdByUser?.username ?? "—"}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {product.currentQuantity}
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline">Pending review</Badge>
                          </TableCell>
                          <TableCell className="text-right">
                            <div className="flex justify-end gap-2">
                              <Button
                                size="sm"
                                onClick={() => handleApprove(product.id)}
                                disabled={isPending || bulkLoading}
                              >
                                <CheckCircle2 className="mr-1 h-4 w-4" />
                                Approve
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => handleDecline(product.id)}
                                disabled={isPending || bulkLoading}
                              >
                                {isPending ? (
                                  <Loader2 className="h-4 w-4 animate-spin" />
                                ) : (
                                  <>
                                    <XCircle className="mr-1 h-4 w-4" />
                                    Decline
                                  </>
                                )}
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
