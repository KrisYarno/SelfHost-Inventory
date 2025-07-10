"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { PackingSheet } from "@/components/orders/packing-sheet";
import type { OrderItem } from "@/types/orders";

// Demo component showing how to use the PackingSheet
export default function PackingSheetDemo() {
  const [isOpen, setIsOpen] = useState(false);
  const locationId = 1; // Demo location ID

  // Sample order items with mixed mapped/unmapped products
  const sampleItems: OrderItem[] = [
    {
      id: "item-1",
      name: "Widget Pro Max",
      quantity: 2,
      currentStock: 50,
      productId: 1,
      isMapped: true
    },
    {
      id: "item-2", 
      name: "Gadget Plus",
      quantity: 1,
      currentStock: 5,
      productId: 2,
      isMapped: true
    },
    {
      id: "item-3",
      name: "Mystery Item (Not in Inventory)",
      quantity: 3,
      currentStock: 0,
      isMapped: false
    },
    {
      id: "item-4",
      name: "Bundle Special",
      quantity: 1,
      currentStock: 10,
      productId: 3,
      isMapped: true,
      bundleItems: [
        { id: "bundle-1", name: "Component A", quantity: 2 },
        { id: "bundle-2", name: "Component B", quantity: 1 }
      ]
    }
  ];

  const handleComplete = async (packedItems: string[]) => {
    console.log("Packed items:", packedItems);
    // The actual API call is handled inside PackingSheet
  };

  const handleSuccess = () => {
    console.log("Order packed successfully!");
    // This is where you'd refresh your orders list
  };

  return (
    <div className="container mx-auto p-6 max-w-2xl">
      <h1 className="text-3xl font-bold mb-6">Packing Sheet Demo</h1>
      
      <Card className="p-6">
        <h2 className="text-xl font-semibold mb-4">Test Order #EXT-001</h2>
        <div className="space-y-2 mb-6">
          <p className="text-sm text-muted-foreground">
            This demo shows the packing sheet with:
          </p>
          <ul className="list-disc list-inside text-sm space-y-1 text-muted-foreground ml-4">
            <li>Mapped products (will deduct from inventory)</li>
            <li>Unmapped products (will show warning)</li>
            <li>Low stock items</li>
            <li>Bundle products</li>
          </ul>
        </div>
        
        <Button onClick={() => setIsOpen(true)} size="lg" className="w-full">
          Open Packing Sheet
        </Button>
      </Card>

      <PackingSheet
        orderId="demo-order-1"
        orderNumber="EXT-001"
        items={sampleItems}
        isOpen={isOpen}
        onClose={() => setIsOpen(false)}
        onComplete={handleComplete}
        onSuccess={handleSuccess}
        locationId={locationId}
      />

      <div className="mt-8 space-y-4">
        <h3 className="text-lg font-semibold">Integration Notes:</h3>
        <div className="bg-muted p-4 rounded-lg space-y-2 text-sm">
          <p><strong>Success Feedback:</strong></p>
          <ul className="list-disc list-inside ml-4 space-y-1">
            <li>Success toast notification</li>
            <li>Confetti animation on mobile devices</li>
            <li>Haptic feedback (vibration) when available</li>
          </ul>
        </div>
        
        <div className="bg-muted p-4 rounded-lg space-y-2 text-sm">
          <p><strong>API Integration:</strong></p>
          <ul className="list-disc list-inside ml-4 space-y-1">
            <li>Validates all items are packed before completion</li>
            <li>Only deducts inventory for mapped products</li>
            <li>Shows warnings for unmapped products</li>
            <li>Clears order lock on success or failure</li>
          </ul>
        </div>

        <div className="bg-muted p-4 rounded-lg space-y-2 text-sm">
          <p><strong>Error Handling:</strong></p>
          <ul className="list-disc list-inside ml-4 space-y-1">
            <li>Stock validation before deduction</li>
            <li>CSRF token validation</li>
            <li>Order lock verification</li>
            <li>Detailed error messages</li>
          </ul>
        </div>
      </div>
    </div>
  );
}