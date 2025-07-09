import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ReviewChangesDialog } from '@/components/journal/review-changes-dialog'
import type { ProductWithQuantity } from '@/types/product'
import type { JournalAdjustment } from '@/hooks/use-journal'

const mockProducts: ProductWithQuantity[] = [
  {
    id: 1,
    name: 'Product 1',
    sku: 'SKU001',
    unit: 'EA',
    description: 'Test product 1',
    isActive: true,
    currentQuantity: 100,
  },
  {
    id: 2,
    name: 'Product 2',
    sku: 'SKU002',
    unit: 'BOX',
    description: 'Test product 2',
    isActive: true,
    currentQuantity: 50,
  },
  {
    id: 3,
    name: 'Product 3',
    sku: 'SKU003',
    unit: 'KG',
    description: 'Test product 3',
    isActive: true,
    currentQuantity: 10,
  },
]

const mockAdjustments: Record<number, JournalAdjustment> = {
  1: { productId: 1, quantityChange: 20 },
  2: { productId: 2, quantityChange: -10 },
  3: { productId: 3, quantityChange: -15 }, // This will cause negative stock
}

describe('ReviewChangesDialog', () => {
  const defaultProps = {
    open: true,
    onOpenChange: jest.fn(),
    adjustments: {},
    products: mockProducts,
    onConfirm: jest.fn(),
    isSubmitting: false,
  }

  afterEach(() => {
    jest.clearAllMocks()
  })

  it('renders the dialog when open', () => {
    render(<ReviewChangesDialog {...defaultProps} />)
    
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByText('Review Changes')).toBeInTheDocument()
    expect(screen.getByText('Please review your inventory adjustments before submitting.')).toBeInTheDocument()
  })

  it('displays summary statistics correctly', () => {
    render(
      <ReviewChangesDialog
        {...defaultProps}
        adjustments={{
          1: { productId: 1, quantityChange: 20 },
          2: { productId: 2, quantityChange: -10 },
        }}
      />
    )

    // Check product count
    expect(screen.getByText('2')).toBeInTheDocument()
    expect(screen.getByText('Products')).toBeInTheDocument()

    // Check additions
    expect(screen.getByText('+20')).toBeInTheDocument()
    expect(screen.getByText('Added')).toBeInTheDocument()

    // Check removals
    expect(screen.getByText('-10')).toBeInTheDocument()
    expect(screen.getByText('Removed')).toBeInTheDocument()
  })

  it('displays adjustment list with product details', () => {
    render(
      <ReviewChangesDialog
        {...defaultProps}
        adjustments={{
          1: { productId: 1, quantityChange: 20 },
          2: { productId: 2, quantityChange: -10 },
        }}
      />
    )

    // Check Product 1
    expect(screen.getByText('Product 1')).toBeInTheDocument()
    expect(screen.getByText('100')).toBeInTheDocument() // Current quantity
    expect(screen.getByText('120')).toBeInTheDocument() // New quantity
    expect(screen.getByText('+20')).toBeInTheDocument()

    // Check Product 2
    expect(screen.getByText('Product 2')).toBeInTheDocument()
    expect(screen.getByText('50')).toBeInTheDocument() // Current quantity
    expect(screen.getByText('40')).toBeInTheDocument() // New quantity
    expect(screen.getByText('-10')).toBeInTheDocument()
  })

  it('shows negative stock warning', () => {
    render(
      <ReviewChangesDialog
        {...defaultProps}
        adjustments={mockAdjustments}
      />
    )

    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(screen.getByText('Stock Warning')).toBeInTheDocument()
    expect(screen.getByText('1 product(s) would have negative stock after these adjustments.')).toBeInTheDocument()
    
    // Check that Product 3 shows negative stock badge
    const negativeStockBadges = screen.getAllByText('Negative Stock')
    expect(negativeStockBadges).toHaveLength(1)
  })

  it('disables confirm button when there are negative stock warnings', () => {
    render(
      <ReviewChangesDialog
        {...defaultProps}
        adjustments={mockAdjustments}
      />
    )

    const confirmButton = screen.getByRole('button', { name: /confirm adjustments/i })
    expect(confirmButton).toBeDisabled()
  })

  it('enables confirm button when no negative stock warnings', () => {
    render(
      <ReviewChangesDialog
        {...defaultProps}
        adjustments={{
          1: { productId: 1, quantityChange: 20 },
          2: { productId: 2, quantityChange: -10 },
        }}
      />
    )

    const confirmButton = screen.getByRole('button', { name: /confirm adjustments/i })
    expect(confirmButton).toBeEnabled()
  })

  it('displays net change correctly', () => {
    render(
      <ReviewChangesDialog
        {...defaultProps}
        adjustments={{
          1: { productId: 1, quantityChange: 20 },
          2: { productId: 2, quantityChange: -30 },
        }}
      />
    )

    expect(screen.getByText('Net Change')).toBeInTheDocument()
    expect(screen.getByLabelText('Net change: -10 units')).toHaveTextContent('-10')
  })

  it('handles cancel button click', async () => {
    const user = userEvent.setup()
    const onOpenChange = jest.fn()
    
    render(
      <ReviewChangesDialog
        {...defaultProps}
        onOpenChange={onOpenChange}
      />
    )

    const cancelButton = screen.getByRole('button', { name: /cancel/i })
    await user.click(cancelButton)

    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('handles confirm button click', async () => {
    const user = userEvent.setup()
    const onConfirm = jest.fn()
    
    render(
      <ReviewChangesDialog
        {...defaultProps}
        onConfirm={onConfirm}
        adjustments={{
          1: { productId: 1, quantityChange: 20 },
        }}
      />
    )

    const confirmButton = screen.getByRole('button', { name: /confirm adjustments/i })
    await user.click(confirmButton)

    expect(onConfirm).toHaveBeenCalled()
  })

  it('shows submitting state', () => {
    render(
      <ReviewChangesDialog
        {...defaultProps}
        isSubmitting={true}
      />
    )

    expect(screen.getByRole('button', { name: /submitting/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /cancel/i })).toBeDisabled()
  })

  it('handles empty adjustments', () => {
    render(<ReviewChangesDialog {...defaultProps} />)

    expect(screen.getByText('0')).toBeInTheDocument() // Products count
    expect(screen.getByText('+0')).toBeInTheDocument() // Added
    expect(screen.getByText('-0')).toBeInTheDocument() // Removed
  })

  it('uses correct ARIA attributes', () => {
    render(
      <ReviewChangesDialog
        {...defaultProps}
        adjustments={{
          1: { productId: 1, quantityChange: 20 },
        }}
      />
    )

    // Check dialog accessibility
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-describedby', 'dialog-description')
    
    // Check summary group
    expect(screen.getByRole('group', { name: 'Summary statistics' })).toBeInTheDocument()
    
    // Check list
    expect(screen.getByRole('list')).toBeInTheDocument()
    expect(screen.getByRole('listitem')).toBeInTheDocument()
  })

  it('handles products not in the product list', () => {
    render(
      <ReviewChangesDialog
        {...defaultProps}
        adjustments={{
          999: { productId: 999, quantityChange: 10 }, // Non-existent product
        }}
      />
    )

    // Should show count in summary but not in the list
    expect(screen.getByText('1')).toBeInTheDocument() // Products count
    expect(screen.queryByText('Product 999')).not.toBeInTheDocument()
  })

  it('correctly identifies increases and decreases', () => {
    render(
      <ReviewChangesDialog
        {...defaultProps}
        adjustments={{
          1: { productId: 1, quantityChange: 0 }, // No change
          2: { productId: 2, quantityChange: 10 }, // Increase
          3: { productId: 3, quantityChange: -5 }, // Decrease
        }}
      />
    )

    // Check that proper icons are shown (by checking aria-labels)
    expect(screen.getByLabelText('Increase')).toBeInTheDocument()
    expect(screen.getByLabelText('Decrease')).toBeInTheDocument()
  })
})