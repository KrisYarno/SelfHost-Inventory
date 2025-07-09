import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { SessionProvider } from 'next-auth/react'
import JournalPage from '@/app/(app)/journal/page'

// Mock the API calls
global.fetch = jest.fn()

const createQueryClient = () => new QueryClient({
  defaultOptions: {
    queries: { retry: false },
    mutations: { retry: false }
  }
})

const TestWrapper = ({ children }: { children: React.ReactNode }) => {
  const queryClient = createQueryClient()
  return (
    <SessionProvider session={{ user: { id: 'test-user' } } as any}>
      <QueryClientProvider client={queryClient}>
        {children}
      </QueryClientProvider>
    </SessionProvider>
  )
}

describe('Mass Update End-to-End Flow', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(global.fetch as jest.Mock).mockClear()
  })

  const mockProducts = [
    {
      id: 1,
      name: 'Widget A',
      sku: 'WGT-A',
      unit: 'EA',
      currentQuantity: 100,
      isActive: true
    },
    {
      id: 2,
      name: 'Gadget B',
      sku: 'GDG-B',
      unit: 'BOX',
      currentQuantity: 50,
      isActive: true
    },
    {
      id: 3,
      name: 'Tool C',
      sku: 'TL-C',
      unit: 'SET',
      currentQuantity: 25,
      isActive: true
    }
  ]

  it('completes a full mass update workflow', async () => {
    const user = userEvent.setup()
    
    // Mock initial product fetch
    ;(global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ products: mockProducts })
    })

    render(
      <TestWrapper>
        <JournalPage />
      </TestWrapper>
    )

    // Wait for products to load
    await waitFor(() => {
      expect(screen.getByText('Widget A')).toBeInTheDocument()
    })

    // Step 1: Add adjustments for multiple products
    
    // Adjust Widget A
    const widgetAInput = screen.getByLabelText(/quantity adjustment for widget a/i)
    await user.clear(widgetAInput)
    await user.type(widgetAInput, '20')
    
    // Adjust Gadget B
    const gadgetBInput = screen.getByLabelText(/quantity adjustment for gadget b/i)
    await user.clear(gadgetBInput)
    await user.type(gadgetBInput, '-10')
    
    // Adjust Tool C
    const toolCInput = screen.getByLabelText(/quantity adjustment for tool c/i)
    await user.clear(toolCInput)
    await user.type(toolCInput, '5')

    // Step 2: Verify the adjustment summary is visible
    expect(screen.getByText(/3 products selected/i)).toBeInTheDocument()
    expect(screen.getByText(/\+25/)).toBeInTheDocument() // Total additions
    expect(screen.getByText(/-10/)).toBeInTheDocument() // Total removals

    // Step 3: Click save button
    const saveButton = screen.getByRole('button', { name: /save all changes/i })
    expect(saveButton).toBeEnabled()
    await user.click(saveButton)

    // Step 4: Review dialog should appear
    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument()
      expect(screen.getByText('Review Changes')).toBeInTheDocument()
    })

    // Verify all adjustments are shown in the review
    expect(screen.getByText('Widget A')).toBeInTheDocument()
    expect(screen.getByText('100 → 120')).toBeInTheDocument()
    
    expect(screen.getByText('Gadget B')).toBeInTheDocument()
    expect(screen.getByText('50 → 40')).toBeInTheDocument()
    
    expect(screen.getByText('Tool C')).toBeInTheDocument()
    expect(screen.getByText('25 → 30')).toBeInTheDocument()

    // Mock the batch adjustment API call
    ;(global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ 
        success: true, 
        count: 3,
        logs: [
          { id: 1, productId: 1, delta: 20 },
          { id: 2, productId: 2, delta: -10 },
          { id: 3, productId: 3, delta: 5 }
        ]
      })
    })

    // Step 5: Confirm the changes
    const confirmButton = screen.getByRole('button', { name: /confirm adjustments/i })
    await user.click(confirmButton)

    // Step 6: Verify success message
    await waitFor(() => {
      expect(screen.getByText(/successfully updated 3 products/i)).toBeInTheDocument()
    })

    // Step 7: Verify adjustments were cleared
    await waitFor(() => {
      const widgetAInputAfter = screen.getByLabelText(/quantity adjustment for widget a/i) as HTMLInputElement
      expect(widgetAInputAfter.value).toBe('0')
    })
  })

  it('handles validation errors during mass update', async () => {
    const user = userEvent.setup()
    
    // Mock initial product fetch with low stock product
    const lowStockProducts = [
      { ...mockProducts[0], currentQuantity: 5 },
      mockProducts[1],
      mockProducts[2]
    ]
    
    ;(global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ products: lowStockProducts })
    })

    render(
      <TestWrapper>
        <JournalPage />
      </TestWrapper>
    )

    await waitFor(() => {
      expect(screen.getByText('Widget A')).toBeInTheDocument()
    })

    // Try to remove more than available
    const widgetAInput = screen.getByLabelText(/quantity adjustment for widget a/i)
    await user.clear(widgetAInput)
    await user.type(widgetAInput, '-10') // Current is 5, trying to remove 10

    // Click save
    const saveButton = screen.getByRole('button', { name: /save/i })
    await user.click(saveButton)

    // Review dialog should show warning
    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument()
      expect(screen.getByText(/stock warning/i)).toBeInTheDocument()
      expect(screen.getByText(/negative stock/i)).toBeInTheDocument()
    })

    // Confirm button should be disabled
    const confirmButton = screen.getByRole('button', { name: /confirm adjustments/i })
    expect(confirmButton).toBeDisabled()
  })

  it('handles API errors gracefully', async () => {
    const user = userEvent.setup()
    
    ;(global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ products: mockProducts })
    })

    render(
      <TestWrapper>
        <JournalPage />
      </TestWrapper>
    )

    await waitFor(() => {
      expect(screen.getByText('Widget A')).toBeInTheDocument()
    })

    // Add an adjustment
    const widgetAInput = screen.getByLabelText(/quantity adjustment for widget a/i)
    await user.type(widgetAInput, '10')

    // Click save
    const saveButton = screen.getByRole('button', { name: /save/i })
    await user.click(saveButton)

    // Wait for review dialog
    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument()
    })

    // Mock API error
    ;(global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ 
        error: { 
          message: 'Database connection failed',
          code: 'DB_ERROR'
        }
      })
    })

    // Confirm the changes
    const confirmButton = screen.getByRole('button', { name: /confirm adjustments/i })
    await user.click(confirmButton)

    // Should show error message
    await waitFor(() => {
      expect(screen.getByText(/database connection failed/i)).toBeInTheDocument()
    })

    // Dialog should remain open for retry
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('handles optimistic locking conflicts', async () => {
    const user = userEvent.setup()
    
    ;(global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ products: mockProducts })
    })

    render(
      <TestWrapper>
        <JournalPage />
      </TestWrapper>
    )

    await waitFor(() => {
      expect(screen.getByText('Widget A')).toBeInTheDocument()
    })

    // Add adjustment
    const widgetAInput = screen.getByLabelText(/quantity adjustment for widget a/i)
    await user.type(widgetAInput, '10')

    const saveButton = screen.getByRole('button', { name: /save/i })
    await user.click(saveButton)

    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument()
    })

    // Mock optimistic lock error
    ;(global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: async () => ({ 
        error: { 
          message: 'One or more items have been modified by another user',
          code: 'OPTIMISTIC_LOCK_ERROR'
        }
      })
    })

    const confirmButton = screen.getByRole('button', { name: /confirm adjustments/i })
    await user.click(confirmButton)

    // Should show specific error message
    await waitFor(() => {
      expect(screen.getByText(/modified by another user/i)).toBeInTheDocument()
    })
  })

  it('allows filtering and searching during mass update', async () => {
    const user = userEvent.setup()
    
    ;(global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ products: mockProducts })
    })

    render(
      <TestWrapper>
        <JournalPage />
      </TestWrapper>
    )

    await waitFor(() => {
      expect(screen.getByText('Widget A')).toBeInTheDocument()
    })

    // Add adjustments
    const widgetAInput = screen.getByLabelText(/quantity adjustment for widget a/i)
    await user.type(widgetAInput, '10')

    // Use search to filter products
    const searchInput = screen.getByPlaceholderText(/search products/i)
    await user.type(searchInput, 'Gadget')

    // Widget A should be hidden, but adjustment should be preserved
    await waitFor(() => {
      expect(screen.queryByText('Widget A')).not.toBeInTheDocument()
      expect(screen.getByText('Gadget B')).toBeInTheDocument()
    })

    // Clear search
    await user.clear(searchInput)

    // Widget A should reappear with adjustment intact
    await waitFor(() => {
      expect(screen.getByText('Widget A')).toBeInTheDocument()
      const widgetInput = screen.getByLabelText(/quantity adjustment for widget a/i) as HTMLInputElement
      expect(widgetInput.value).toBe('10')
    })
  })
})