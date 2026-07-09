/**
 * @jest-environment jsdom
 */
import React from 'react'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ReviewChangesDialog } from '@/components/journal/review-changes-dialog'
import type { ProductWithQuantity } from '@/types/product'
import type { JournalAdjustment } from '@/hooks/use-journal'

const createMockProduct = (
  id: number,
  name: string,
  currentQuantity: number,
  unit: string
): ProductWithQuantity => ({
  id,
  name,
  baseName: null,
  variant: null,
  unit,
  numericValue: null,
  quantity: currentQuantity,
  location: 1,
  lowStockThreshold: 10,
  deletedAt: null,
  deletedBy: null,
  costPrice: 0 as any,
  retailPrice: 0 as any,
  priceSourceLinkId: null,
  approvalStatus: "APPROVED",
  createdBy: null,
  reviewedBy: null,
  reviewedAt: null,
  currentQuantity,
});

const mockProducts: ProductWithQuantity[] = [
  createMockProduct(1, 'Product 1', 100, 'EA'),
  createMockProduct(2, 'Product 2', 50, 'BOX'),
  createMockProduct(3, 'Product 3', 10, 'KG'),
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

    // '+20'/'-10' also render in the per-product adjustment list below, so scope
    // the summary assertions to the "Summary statistics" group.
    const summary = screen.getByRole('group', { name: 'Summary statistics' })

    // Check product count
    expect(within(summary).getByText('2')).toBeInTheDocument()
    expect(within(summary).getByText('Products')).toBeInTheDocument()

    // Check additions
    expect(within(summary).getByText('+20')).toBeInTheDocument()
    expect(within(summary).getByText('Added')).toBeInTheDocument()

    // Check removals
    expect(within(summary).getByText('-10')).toBeInTheDocument()
    expect(within(summary).getByText('Removed')).toBeInTheDocument()
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

    // '+20'/'-10' also render in the summary above, so scope these to the
    // adjustment list (role="list").
    const list = screen.getByRole('list')

    // Check Product 1
    expect(within(list).getByText('Product 1')).toBeInTheDocument()
    expect(within(list).getByText('100')).toBeInTheDocument() // Current quantity
    expect(within(list).getByText('120')).toBeInTheDocument() // New quantity
    expect(within(list).getByText('+20')).toBeInTheDocument()

    // Check Product 2
    expect(within(list).getByText('Product 2')).toBeInTheDocument()
    expect(within(list).getByText('50')).toBeInTheDocument() // Current quantity
    expect(within(list).getByText('40')).toBeInTheDocument() // New quantity
    expect(within(list).getByText('-10')).toBeInTheDocument()
  })

  it('shows negative stock warning', () => {
    render(
      <ReviewChangesDialog
        {...defaultProps}
        adjustments={mockAdjustments}
      />
    )

    // The dialog renders two role="alert" nodes: the warning banner and the
    // per-row "Negative Stock" badge. Assert an alert exists, then pin the banner
    // via its heading text.
    expect(screen.getAllByRole('alert').length).toBeGreaterThan(0)
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

    const confirmButton = screen.getByRole('button', { name: /confirm and submit adjustments/i })
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

    const confirmButton = screen.getByRole('button', { name: /confirm and submit adjustments/i })
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

    const confirmButton = screen.getByRole('button', { name: /confirm and submit adjustments/i })
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

    // The Net Change badge also renders '0', so scope the count/added/removed
    // assertions to the "Summary statistics" group.
    const summary = screen.getByRole('group', { name: 'Summary statistics' })
    expect(within(summary).getByText('0')).toBeInTheDocument() // Products count
    expect(within(summary).getByText('+0')).toBeInTheDocument() // Added
    expect(within(summary).getByText('-0')).toBeInTheDocument() // Removed
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

    // The component maps quantityChange > 0 to an "Increase" icon and everything
    // else (including a 0 change) to "Decrease", so Product 1's 0-change row also
    // renders a "Decrease" label. Scope to the specific rows to assert the
    // meaningful mapping: a positive change shows Increase, a negative shows Decrease.
    const increaseRow = screen.getByRole('listitem', {
      name: /Product 2: changing from 50 to 60/i,
    })
    expect(within(increaseRow).getByLabelText('Increase')).toBeInTheDocument()

    const decreaseRow = screen.getByRole('listitem', {
      name: /Product 3: changing from 10 to 5/i,
    })
    expect(within(decreaseRow).getByLabelText('Decrease')).toBeInTheDocument()
  })
})
