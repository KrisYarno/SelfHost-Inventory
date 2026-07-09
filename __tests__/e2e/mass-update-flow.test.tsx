/**
 * @jest-environment jsdom
 */
import React from 'react'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Toaster, toast } from 'sonner'
import JournalPage from '@/app/(app)/journal/page'
import { useJournalStore } from '@/hooks/use-journal'

// next-auth/react is mocked globally in jest.setup.js (useSession -> loading),
// which keeps JournalPage from redirecting unauthenticated users.

// The journal page relies on the app router, the location + CSRF contexts, and
// the inventory-products query. Mock those boundaries so the test can drive the
// real journal UI (rows, adjustment inputs, review dialog) deterministically.
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn() }),
}))

jest.mock('@/hooks/use-csrf', () => ({
  useCSRF: () => ({ token: 'csrf-token', isLoading: false }),
  withCSRFHeaders: (h: Record<string, string>) => ({ ...h, 'x-csrf-token': 'csrf-token' }),
}))

jest.mock('@/contexts/location-context', () => ({
  useLocation: () => ({
    selectedLocationId: 1,
    selectedLocation: { id: 1, name: 'Main Warehouse' },
    locations: [{ id: 1, name: 'Main Warehouse' }],
    setSelectedLocationId: jest.fn(),
    isLoading: false,
  }),
}))

// Products are served through a mutable holder so each test can seed its own
// fixture; this bypasses the two-endpoint fetch inside useInventoryProducts.
const mockInventoryState: { products: any[] } = { products: [] }
const mockRefetch = jest.fn()
jest.mock('@/hooks/use-inventory-products', () => ({
  useInventoryProducts: () => ({
    data: mockInventoryState.products,
    isLoading: false,
    refetch: mockRefetch,
  }),
}))

const createQueryClient = () =>
  new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  })

const TestWrapper = ({ children }: { children: React.ReactNode }) => {
  const queryClient = createQueryClient()
  return (
    <QueryClientProvider client={queryClient}>
      {children}
      {/* Success/error feedback surfaces as sonner toasts, so render a Toaster. */}
      <Toaster />
    </QueryClientProvider>
  )
}

const mockProducts = [
  { id: 1, name: 'Widget A', sku: 'WGT-A', unit: 'EA', currentQuantity: 100, lowStockThreshold: 10 },
  { id: 2, name: 'Gadget B', sku: 'GDG-B', unit: 'BOX', currentQuantity: 50, lowStockThreshold: 10 },
  { id: 3, name: 'Tool C', sku: 'TL-C', unit: 'SET', currentQuantity: 25, lowStockThreshold: 10 },
]

// jsdom applies no CSS, so each product row renders BOTH its desktop and mobile
// layouts (each with its own adjustment spinbutton). Scope by the row's article
// (aria-label "Product <name>, current quantity <n>") and use the first
// spinbutton — both are wired to the same onChange handler.
const getRow = (name: string) =>
  screen.getByRole('article', {
    name: new RegExp(`Product ${name}, current quantity`, 'i'),
  })

async function setAdjustment(
  user: ReturnType<typeof userEvent.setup>,
  productName: string,
  value: number
) {
  const input = within(getRow(productName)).getAllByRole('spinbutton')[0]
  await user.click(input) // focus (clears a 0 value to empty)
  await user.clear(input)
  await user.type(input, String(value))
  await user.tab() // blur -> AdjustmentInput commits the value via onChange
}

describe('Mass Update End-to-End Flow', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    global.fetch = jest.fn() as jest.Mock
    // Reset the persisted journal store between tests.
    localStorage.clear()
    useJournalStore.setState({ adjustments: {} })
    mockInventoryState.products = []
  })

  afterEach(() => {
    toast.dismiss()
  })

  it('completes a full mass update workflow', async () => {
    const user = userEvent.setup()
    mockInventoryState.products = mockProducts

    render(
      <TestWrapper>
        <JournalPage />
      </TestWrapper>
    )

    // Wait for products to load
    await waitFor(() => {
      expect(getRow('Widget A')).toBeInTheDocument()
    })

    // Step 1: Add adjustments for multiple products
    await setAdjustment(user, 'Widget A', 20)
    await setAdjustment(user, 'Gadget B', -10)
    await setAdjustment(user, 'Tool C', 5)

    // Step 2: Verify the pending-changes summary reflects the totals
    // (additions 20+5=25, removals 10). Scope to the summary region because the
    // per-row change previews render the same numbers.
    const summary = screen.getByRole('region', { name: 'Pending changes summary' })
    expect(within(summary).getByText(/3 products/i)).toBeInTheDocument()
    expect(within(summary).getByText('+25')).toBeInTheDocument() // Total additions
    expect(within(summary).getByText('-10')).toBeInTheDocument() // Total removals

    // Step 3: Open the review dialog
    const reviewButton = screen.getByRole('button', { name: /review & submit/i })
    expect(reviewButton).toBeEnabled()
    await user.click(reviewButton)

    // Step 4: Review dialog should appear with each adjustment
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Review Changes')).toBeInTheDocument()

    expect(
      within(dialog).getByRole('listitem', { name: /Widget A: changing from 100 to 120/i })
    ).toBeInTheDocument()
    expect(
      within(dialog).getByRole('listitem', { name: /Gadget B: changing from 50 to 40/i })
    ).toBeInTheDocument()
    expect(
      within(dialog).getByRole('listitem', { name: /Tool C: changing from 25 to 30/i })
    ).toBeInTheDocument()

    // Mock the batch adjustment API call
    ;(global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        count: 3,
        logs: [
          { id: 1, productId: 1, delta: 20 },
          { id: 2, productId: 2, delta: -10 },
          { id: 3, productId: 3, delta: 5 },
        ],
      }),
    })

    // Step 5: Confirm the changes
    const confirmButton = within(dialog).getByRole('button', {
      name: /confirm and submit adjustments/i,
    })
    await user.click(confirmButton)

    // Step 6: Verify success feedback (sonner toast)
    expect(await screen.findByText('Successfully submitted 3 adjustments')).toBeInTheDocument()

    // All three adjustments were sent to the batch endpoint in one request.
    const batchCall = (global.fetch as jest.Mock).mock.calls.find(
      (c) => c[0] === '/api/inventory/batch-adjust'
    )
    expect(batchCall).toBeTruthy()
    expect(batchCall[1].method).toBe('POST')
    expect(JSON.parse(batchCall[1].body).adjustments).toHaveLength(3)

    // Step 7: Verify adjustments were cleared (input resets to 0)
    await waitFor(() => {
      const widgetAInputAfter = within(getRow('Widget A')).getAllByRole(
        'spinbutton'
      )[0] as HTMLInputElement
      expect(widgetAInputAfter.value).toBe('0')
    })
  })

  it('handles validation errors during mass update', async () => {
    const user = userEvent.setup()

    // Widget A only has 5 in stock. The AdjustmentInput now clamps at
    // -currentQuantity, so you cannot type an over-removal that reaches the
    // review dialog. The last line of defence is the review dialog's negative
    // stock guard, which fires if stock changes underneath an already-queued
    // adjustment. Seed such a state directly (a -10 removal against 5 in stock).
    mockInventoryState.products = [{ ...mockProducts[0], currentQuantity: 5 }, mockProducts[1], mockProducts[2]]
    useJournalStore.setState({ adjustments: { 1: { productId: 1, quantityChange: -10 } } })

    render(
      <TestWrapper>
        <JournalPage />
      </TestWrapper>
    )

    await waitFor(() => {
      expect(getRow('Widget A')).toBeInTheDocument()
    })

    // Open the review dialog
    await user.click(screen.getByRole('button', { name: /review & submit/i }))

    // Review dialog should show the negative-stock warning
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getAllByRole('alert').length).toBeGreaterThan(0)
    expect(within(dialog).getByText('Stock Warning')).toBeInTheDocument()
    expect(
      within(dialog).getByText('1 product(s) would have negative stock after these adjustments.')
    ).toBeInTheDocument()

    // Confirm button must be disabled while a negative-stock warning is present
    const confirmButton = within(dialog).getByRole('button', {
      name: /confirm and submit adjustments/i,
    })
    expect(confirmButton).toBeDisabled()
  })

  it('handles API errors gracefully', async () => {
    const user = userEvent.setup()
    mockInventoryState.products = mockProducts

    render(
      <TestWrapper>
        <JournalPage />
      </TestWrapper>
    )

    await waitFor(() => {
      expect(getRow('Widget A')).toBeInTheDocument()
    })

    // Add an adjustment
    await setAdjustment(user, 'Widget A', 10)

    // Open review dialog
    await user.click(screen.getByRole('button', { name: /review & submit/i }))
    const dialog = await screen.findByRole('dialog')

    // Mock API error
    ;(global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({
        error: {
          message: 'Database connection failed',
          code: 'DB_ERROR',
        },
      }),
    })

    // Confirm the changes
    await user.click(
      within(dialog).getByRole('button', { name: /confirm and submit adjustments/i })
    )

    // Should surface the server error message in a toast. Match the exact string
    // so it doesn't also match the (longer) screen-reader announcement text.
    expect(await screen.findByText('Database connection failed')).toBeInTheDocument()

    // Dialog should remain open for retry
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('handles optimistic locking conflicts', async () => {
    const user = userEvent.setup()
    mockInventoryState.products = mockProducts

    render(
      <TestWrapper>
        <JournalPage />
      </TestWrapper>
    )

    await waitFor(() => {
      expect(getRow('Widget A')).toBeInTheDocument()
    })

    // Add adjustment
    await setAdjustment(user, 'Widget A', 10)

    await user.click(screen.getByRole('button', { name: /review & submit/i }))
    const dialog = await screen.findByRole('dialog')

    // Mock optimistic lock error (nested structured shape, HTTP 409)
    ;(global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: async () => ({
        error: {
          message: 'One or more items have been modified by another user',
          code: 'OPTIMISTIC_LOCK_ERROR',
        },
      }),
    })

    await user.click(
      within(dialog).getByRole('button', { name: /confirm and submit adjustments/i })
    )

    // Should show the specific conflict message in the toast
    expect(
      await screen.findByText('One or more items have been modified by another user')
    ).toBeInTheDocument()
  })

  it('allows filtering and searching during mass update', async () => {
    const user = userEvent.setup()
    mockInventoryState.products = mockProducts

    render(
      <TestWrapper>
        <JournalPage />
      </TestWrapper>
    )

    await waitFor(() => {
      expect(getRow('Widget A')).toBeInTheDocument()
    })

    // Add an adjustment to Widget A
    await setAdjustment(user, 'Widget A', 10)

    // Use search to filter products down to Gadget
    const searchInput = screen.getByPlaceholderText(/search products/i)
    await user.type(searchInput, 'Gadget')

    // Widget A should be hidden; Gadget B should remain
    await waitFor(() => {
      expect(
        screen.queryByRole('article', { name: /Product Widget A, current quantity/i })
      ).not.toBeInTheDocument()
      expect(getRow('Gadget B')).toBeInTheDocument()
    })

    // Clear search
    await user.clear(searchInput)

    // Widget A should reappear with its adjustment intact (persisted in the store)
    await waitFor(() => {
      const widgetInput = within(getRow('Widget A')).getAllByRole(
        'spinbutton'
      )[0] as HTMLInputElement
      expect(widgetInput.value).toBe('10')
    })
  })
})
