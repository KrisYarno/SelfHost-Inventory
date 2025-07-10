'use client'

import React, { useEffect, useState, useCallback, useRef } from 'react'
import { X, Package, AlertCircle, RefreshCw, Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Progress } from '@/components/ui/progress'
import { Checkbox } from '@/components/ui/checkbox'
import { Badge } from '@/components/ui/badge'
import { usePackingStore } from '@/hooks/use-packing-store'
import { toast } from 'sonner'
import type { OrderItem } from '@/types/orders'
import { addCSRFHeader } from '@/lib/csrf-client'

interface PackingSheetProps {
  orderId: string
  orderNumber: string
  items: OrderItem[]
  isOpen: boolean
  onClose: () => void
  onComplete: (packedItems: string[]) => Promise<void>
  onSuccess?: () => void
  locationId: number
}

export function PackingSheet({
  orderId,
  orderNumber,
  items,
  isOpen,
  onClose,
  onComplete,
  onSuccess,
  locationId
}: PackingSheetProps) {
  const [isLoading, setIsLoading] = useState(false)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [currentItems, setCurrentItems] = useState(items)
  const [isVisible, setIsVisible] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const [dragStartY, setDragStartY] = useState(0)
  const [translateY, setTranslateY] = useState(0)
  
  const mobileSheetRef = useRef<HTMLDivElement>(null)
  
  const {
    packedItems,
    addPackedItem,
    removePackedItem,
    clearPackedItems,
    isItemPacked
  } = usePackingStore()

  const totalItems = currentItems.reduce((sum, item) => sum + item.quantity, 0)
  const packedCount = currentItems.filter(item => isItemPacked(item.id)).reduce(
    (sum, item) => sum + item.quantity, 0
  )
  const progress = totalItems > 0 ? (packedCount / totalItems) * 100 : 0
  const allItemsPacked = currentItems.every(item => isItemPacked(item.id))

  // Animate in/out
  useEffect(() => {
    if (isOpen) {
      // Force reflow for animation
      requestAnimationFrame(() => {
        setIsVisible(true)
      })
    } else {
      setIsVisible(false)
      // Wait for animation to complete before clearing
      const timer = setTimeout(() => {
        clearPackedItems()
        setTranslateY(0)
      }, 300)
      return () => clearTimeout(timer)
    }
  }, [isOpen, clearPackedItems])

  // Handle refresh
  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true)
    
    // Simulate API call to refresh items
    await new Promise(resolve => setTimeout(resolve, 1000))
    
    // In real app, fetch fresh data here
    setCurrentItems([...items])
    
    setIsRefreshing(false)
    toast.success('Items refreshed')
  }, [items])

  // Handle item toggle
  const handleItemToggle = useCallback((itemId: string, checked: boolean) => {
    if (checked) {
      addPackedItem(itemId)
    } else {
      removePackedItem(itemId)
    }

    // Haptic feedback on iOS
    if (window.navigator && 'vibrate' in window.navigator) {
      window.navigator.vibrate(10)
    }
  }, [addPackedItem, removePackedItem])

  // Handle complete order
  const handleCompleteOrder = async () => {
    if (!allItemsPacked) {
      toast.error('Please pack all items before completing the order')
      return
    }

    setIsLoading(true)
    
    try {
      // Prepare packed items data for API
      const packedItemsData = currentItems
        .filter(item => isItemPacked(item.id))
        .map(item => ({
          orderItemId: item.id,
          productId: item.productId || 0, // Will be handled by API for unmapped items
          quantity: item.quantity
        }))

      // Call the pack API endpoint
      const response = await fetch(`/api/orders/external/${orderId}/pack`, {
        method: 'POST',
        headers: addCSRFHeader({
          'Content-Type': 'application/json'
        }),
        body: JSON.stringify({
          locationId,
          items: packedItemsData
        })
      })

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error || 'Failed to pack order')
      }

      // Success feedback
      toast.success(`Order #${orderNumber} packed successfully!`)
      
      // Haptic success feedback
      if (window.navigator && 'vibrate' in window.navigator) {
        window.navigator.vibrate([50, 30, 50]) // Success pattern
      }

      // Confetti animation on mobile
      if (window.innerWidth < 768) {
        import('canvas-confetti').then((confettiModule) => {
          const confetti = confettiModule.default
          confetti({
            particleCount: 100,
            spread: 70,
            origin: { y: 0.6 }
          })
        })
      }

      // Close sheet and trigger success callback
      onClose()
      if (onSuccess) {
        onSuccess()
      }
    } catch (error) {
      console.error('Error packing order:', error)
      toast.error(error instanceof Error ? error.message : 'Failed to pack order')
    } finally {
      setIsLoading(false)
    }
  }

  // Touch handlers for swipe to dismiss
  const handleTouchStart = (e: React.TouchEvent) => {
    setIsDragging(true)
    setDragStartY(e.touches[0].clientY)
  }

  const handleTouchMove = (e: React.TouchEvent) => {
    if (!isDragging) return
    
    const currentY = e.touches[0].clientY
    const diff = currentY - dragStartY
    
    // Only allow dragging down
    if (diff > 0) {
      setTranslateY(diff)
    }
  }

  const handleTouchEnd = () => {
    setIsDragging(false)
    
    // If dragged more than 100px, close the sheet
    if (translateY > 100) {
      onClose()
    } else {
      // Snap back
      setTranslateY(0)
    }
  }

  // Mobile sheet variant
  const mobileSheet = (
    <div
      ref={mobileSheetRef}
      className={cn(
        "fixed inset-0 z-50 bg-background md:hidden transition-transform duration-300 ease-out",
        isVisible ? "translate-y-0" : "translate-y-full"
      )}
      style={{
        transform: `translateY(${isVisible ? translateY : '100%'}px)`,
        transition: isDragging ? 'none' : 'transform 0.3s ease-out'
      }}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      {/* Drag handle */}
      <div className="flex justify-center pt-2 pb-4">
        <div className="h-1 w-12 rounded-full bg-muted-foreground/20" />
      </div>

      {/* Header */}
      <div className="px-4 pb-4 border-b">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h2 className="text-2xl font-bold">Order #{orderNumber}</h2>
            <p className="text-sm text-muted-foreground">
              {packedCount} of {totalItems} items packed
            </p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            className="shrink-0"
          >
            <X className="h-5 w-5" />
          </Button>
        </div>
        <Progress value={progress} className="h-2" />
      </div>

      {/* Items list */}
      <ScrollArea className="flex-1 px-4 py-4" style={{ height: 'calc(100vh - 200px)' }}>
        <div className="space-y-2">
          {currentItems.map((item) => (
            <PackingItem
              key={item.id}
              item={item}
              isPacked={isItemPacked(item.id)}
              onToggle={handleItemToggle}
            />
          ))}
        </div>

        {/* Pull to refresh indicator */}
        {isRefreshing && (
          <div className="flex justify-center py-4">
            <RefreshCw className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        )}
      </ScrollArea>

      {/* Footer */}
      <div className="border-t p-4 space-y-3">
        <Button
          onClick={handleRefresh}
          variant="outline"
          className="w-full"
          disabled={isRefreshing}
        >
          <RefreshCw className={cn("h-4 w-4 mr-2", isRefreshing && "animate-spin")} />
          Refresh Items
        </Button>
        <Button
          onClick={handleCompleteOrder}
          disabled={!allItemsPacked || isLoading}
          className="w-full"
          size="lg"
        >
          {isLoading ? (
            <>
              <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
              Completing...
            </>
          ) : (
            <>
              <Package className="h-4 w-4 mr-2" />
              Complete Order
            </>
          )}
        </Button>
      </div>
    </div>
  )

  // Desktop modal variant
  const desktopModal = (
    <div className={cn(
      "fixed inset-0 z-50 hidden md:flex items-center justify-center p-4 transition-opacity duration-300",
      isVisible ? "opacity-100" : "opacity-0 pointer-events-none"
    )}>
      <div
        className={cn(
          "absolute inset-0 bg-background/80 backdrop-blur-sm transition-opacity duration-300",
          isVisible ? "opacity-100" : "opacity-0"
        )}
        onClick={onClose}
      />
      
      <div
        className={cn(
          "relative bg-background border rounded-lg shadow-lg w-full max-w-2xl max-h-[80vh] flex flex-col transition-all duration-300",
          isVisible ? "scale-100 opacity-100" : "scale-95 opacity-0"
        )}
      >
        {/* Header */}
        <div className="px-6 py-4 border-b">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h2 className="text-xl font-semibold">Order #{orderNumber}</h2>
              <p className="text-sm text-muted-foreground">
                {packedCount} of {totalItems} items packed
              </p>
            </div>
            <Button
              variant="ghost"
              size="icon"
              onClick={onClose}
              className="shrink-0"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
          <Progress value={progress} className="h-2" />
        </div>

        {/* Items list */}
        <ScrollArea className="flex-1 px-6 py-4">
          <div className="space-y-2">
            {currentItems.map((item) => (
              <PackingItem
                key={item.id}
                item={item}
                isPacked={isItemPacked(item.id)}
                onToggle={handleItemToggle}
              />
            ))}
          </div>
        </ScrollArea>

        {/* Footer */}
        <div className="border-t px-6 py-4 flex gap-3">
          <Button
            onClick={handleRefresh}
            variant="outline"
            disabled={isRefreshing}
          >
            <RefreshCw className={cn("h-4 w-4 mr-2", isRefreshing && "animate-spin")} />
            Refresh
          </Button>
          <Button
            onClick={handleCompleteOrder}
            disabled={!allItemsPacked || isLoading}
            className="flex-1"
          >
            {isLoading ? (
              <>
                <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                Completing...
              </>
            ) : (
              <>
                <Package className="h-4 w-4 mr-2" />
                Complete Order
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  )

  if (!isOpen && !isVisible) return null

  return (
    <>
      {mobileSheet}
      {desktopModal}
    </>
  )
}

// Individual packing item component
interface OrderItemExtended extends OrderItem {
  productId?: number
  isMapped?: boolean
}

interface PackingItemProps {
  item: OrderItemExtended
  isPacked: boolean
  onToggle: (itemId: string, checked: boolean) => void
}

function PackingItem({ item, isPacked, onToggle }: PackingItemProps) {
  const hasLowStock = item.currentStock < item.quantity
  const isBundle = item.bundleItems && item.bundleItems.length > 0
  const isUnmapped = !item.productId || item.isMapped === false
  const [isPressed, setIsPressed] = useState(false)

  return (
    <div
      className={cn(
        "border rounded-lg p-4 transition-all duration-150",
        isPacked && "bg-muted/50 border-primary/50",
        isPressed && "scale-[0.98]"
      )}
      onTouchStart={() => setIsPressed(true)}
      onTouchEnd={() => setIsPressed(false)}
      onMouseDown={() => setIsPressed(true)}
      onMouseUp={() => setIsPressed(false)}
      onMouseLeave={() => setIsPressed(false)}
    >
      <div className="flex items-start gap-3">
        <Checkbox
          id={item.id}
          checked={isPacked}
          onCheckedChange={(checked) => onToggle(item.id, checked as boolean)}
          className="mt-1"
        />
        
        <div className="flex-1 space-y-2">
          <label
            htmlFor={item.id}
            className="block cursor-pointer"
          >
            <div className="flex items-center justify-between">
              <span className={cn(
                "font-medium",
                isPacked && "line-through text-muted-foreground"
              )}>
                {item.name}
              </span>
              {isPacked && (
                <Check className="h-4 w-4 text-primary" />
              )}
            </div>
            
            <div className="flex items-center gap-4 text-sm text-muted-foreground mt-1">
              <span>Qty: {item.quantity}</span>
              <span>Stock: {item.currentStock}</span>
              {hasLowStock && (
                <Badge variant="destructive" className="text-xs">
                  <AlertCircle className="h-3 w-3 mr-1" />
                  Low Stock
                </Badge>
              )}
              {isUnmapped && (
                <Badge variant="outline" className="text-xs">
                  <AlertCircle className="h-3 w-3 mr-1" />
                  Not Mapped
                </Badge>
              )}
            </div>
          </label>

          {/* Bundle items */}
          {isBundle && item.bundleItems && (
            <div className="ml-4 space-y-1 border-l-2 border-muted pl-4">
              {item.bundleItems.map((bundleItem) => (
                <div key={bundleItem.id} className="text-sm text-muted-foreground">
                  <span>{bundleItem.name}</span>
                  <span className="ml-2">× {bundleItem.quantity}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}