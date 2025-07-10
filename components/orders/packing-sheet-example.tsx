'use client'

import { useState } from 'react'
import { PackingSheet } from './packing-sheet'
import { Button } from '@/components/ui/button'
import type { OrderItem } from '@/types/orders'

// Example usage of the PackingSheet component
export function PackingSheetExample() {
  const [isOpen, setIsOpen] = useState(false)

  // Example order items
  const orderItems: OrderItem[] = [
    {
      id: '1',
      name: 'Widget A',
      quantity: 5,
      currentStock: 10
    },
    {
      id: '2',
      name: 'Widget B',
      quantity: 3,
      currentStock: 2 // Low stock example
    },
    {
      id: '3',
      name: 'Bundle Package',
      quantity: 2,
      currentStock: 5,
      bundleItems: [
        { id: 'b1', name: 'Component X', quantity: 2 },
        { id: 'b2', name: 'Component Y', quantity: 1 }
      ]
    }
  ]

  const handleCompleteOrder = async (packedItems: string[]) => {
    // Simulate API call
    await new Promise(resolve => setTimeout(resolve, 1500))
    
    console.log('Order completed with packed items:', packedItems)
    
    // In a real app, you would:
    // 1. Call API to mark order as completed
    // 2. Update inventory levels
    // 3. Generate shipping label
    // 4. Send confirmation email
  }

  return (
    <div className="p-4">
      <Button onClick={() => setIsOpen(true)}>
        Open Packing Sheet
      </Button>

      <PackingSheet
        orderId="order-123"
        orderNumber="ORD-2024-001"
        items={orderItems}
        isOpen={isOpen}
        onClose={() => setIsOpen(false)}
        onComplete={handleCompleteOrder}
      />
    </div>
  )
}