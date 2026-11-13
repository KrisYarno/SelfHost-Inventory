/** @jest-environment jsdom */
/**
 * Edit Product's reorder overrides — § P2-B3-1R, M-b3 fix 8 (MS-2-2; R107
 * OC-6 / G1-1; R108-OC-8).
 *
 * Two faults, one fix:
 *   - The dialog was handed the LIST's product (`/api/products/optimized`), which
 *     carries no `reorderConfig`, so the form never showed an override at all.
 *     Now `EditProductDialog` reads `GET /api/products/[id]` first (`Loading…`
 *     until it answers; `Couldn't load this product.` and no form on an error),
 *     and the form seeds from that live answer.
 *   - The form sent only non-blank overrides, and the PUT updates only the keys
 *     it is sent, so a cleared override silently stayed. Now `ProductForm`
 *     compares each field with the value it mounted with: equal -> omitted;
 *     cleared -> `null` (lead time, buffer, reorder point) or `1` (MOQ is not
 *     nullable: schema `lib/validation/product.ts:20`, DB `@default(1)`);
 *     otherwise the new value. Untouched -> no `reorderConfig` key at all.
 *   - Create (all-null mount defaults) is byte-identical to before.
 *
 * Plus the host: `app/(app)/products/page.tsx` mounts the dialog per open
 * (M-a.3), so every open — the same product included — reads afresh.
 */

import * as React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useSession } from "next-auth/react";

jest.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: jest.fn(), push: jest.fn(), replace: jest.fn() }),
}));
jest.mock("@/hooks/use-csrf", () => ({
  useCSRF: () => ({ token: "t", isLoading: false, error: null, refreshToken: async () => {} }),
  withCSRFHeaders: (h: HeadersInit) => h,
}));
jest.mock("sonner", () => ({
  toast: { error: jest.fn(), success: jest.fn(), warning: jest.fn() },
}));
jest.mock("@/hooks/use-low-stock-default", () => ({
  useLowStockDefault: () => 10,
}));

// The page arm: everything on the products page except the edit dialog is a
// stub, so the only GET /api/products/[id] reads are the dialog's.
type ListProduct = { id: number; name: string };
jest.mock("@/components/products/product-list-optimized", () => ({
  ProductListOptimized: ({ onEdit }: { onEdit?: (p: ListProduct) => void }) => (
    <div>
      <button onClick={() => onEdit?.(LIST_PRODUCTS[5] as never)}>Edit 5</button>
      <button onClick={() => onEdit?.(LIST_PRODUCTS[6] as never)}>Edit 6</button>
    </div>
  ),
}));
jest.mock("@/components/products/deleted-products-list", () => ({ DeletedProductsList: () => null }));
jest.mock("@/components/products/create-product-dialog", () => ({ CreateProductDialog: () => null }));
jest.mock("@/components/products/delete-product-dialog", () => ({ DeleteProductDialog: () => null }));
jest.mock("@/components/inventory/quick-adjust-dialog", () => ({ QuickAdjustDialog: () => null }));
jest.mock("@/components/inventory/stock-in-dialog", () => ({ StockInDialog: () => null }));
jest.mock("@/components/layout/page-header", () => ({
  PageHeader: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));

import { EditProductDialog } from "@/components/products/edit-product-dialog";
import { ProductForm } from "@/components/products/product-form";
import ProductsPage from "@/app/(app)/products/page";

/** What `/api/products/optimized` hands the page: NO `reorderConfig`. */
const listProduct = (id: number) => ({
  id,
  name: `BPC ${id} Vial`,
  baseName: `BPC ${id}`,
  variant: "Vial",
  unit: null,
  numericValue: null,
  costPrice: null,
  retailPrice: null,
  lowStockThreshold: null,
  approvalStatus: "APPROVED",
  currentQuantity: 3,
});
const LIST_PRODUCTS: Record<number, ReturnType<typeof listProduct>> = {
  5: listProduct(5),
  6: listProduct(6),
};

type Overrides = {
  leadTimeDays: number | null;
  customSafetyStockDays: number | null;
  minOrderQuantity: number;
  reorderPointOverride: number | null;
};
/** What `GET /api/products/[id]` answers: the product WITH its reorder config. */
const liveProduct = (id: number, reorderConfig: Overrides | null) => ({
  ...listProduct(id),
  reorderConfig: reorderConfig && { id: 100 + id, productId: id, ...reorderConfig },
  inventory_logs: [],
});
const CONFIG_5: Overrides = {
  leadTimeDays: 7,
  customSafetyStockDays: 2,
  minOrderQuantity: 5,
  reorderPointOverride: 12,
};

type Answer = { ok: boolean; status: number; json: () => Promise<unknown> };
/** Every GET /api/products/[id], answered by hand, in call order. */
let reads: Array<{ url: string; resolve: (a: Answer) => void; reject: (e: unknown) => void }> = [];

beforeEach(() => {
  jest.clearAllMocks();
  reads = [];
  global.fetch = jest.fn((url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (!init?.method || init.method === "GET") {
      return new Promise<Answer>((resolve, reject) => reads.push({ url: u, resolve, reject }));
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({ id: 5, name: "BPC 5 Vial" }),
    });
  }) as unknown as typeof fetch;
});

const ok = (body: unknown): Answer => ({ ok: true, status: 200, json: async () => body });

async function answer(i: number, a: Answer) {
  await act(async () => {
    reads[i].resolve(a);
  });
}

/** The PUT bodies sent, parsed. */
const puts = () =>
  (global.fetch as jest.Mock).mock.calls
    .filter(([, init]) => (init as RequestInit | undefined)?.method === "PUT")
    .map(([url, init]) => ({
      url: String(url),
      body: JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>,
    }));

function renderDialog(id = 5) {
  return render(
    <EditProductDialog product={LIST_PRODUCTS[id] as never} open onOpenChange={jest.fn()} />,
  );
}

async function renderLoaded(config: Overrides | null = CONFIG_5) {
  renderDialog(5);
  await answer(0, ok(liveProduct(5, config)));
  await screen.findByRole("button", { name: "Update Product" });
}

const field = (label: RegExp) => screen.getByLabelText(label) as HTMLInputElement;

async function submitAndReadPut() {
  fireEvent.click(screen.getByRole("button", { name: "Update Product" }));
  await waitFor(() => expect(puts()).toHaveLength(1));
  return puts()[0];
}

describe("EditProductDialog — the live read (MS-2-2 / G1-1)", () => {
  it("shows Loading… and no form until GET /api/products/[id] answers", () => {
    renderDialog(5);
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Update Product" })).toBeNull();
    expect(reads).toHaveLength(1);
    expect(reads[0].url).toBe("/api/products/5");
  });

  it("the live read supplies the form: the stored overrides are shown", async () => {
    await renderLoaded();
    expect(screen.queryByText("Loading…")).toBeNull();
    expect(field(/Lead time/i).value).toBe("7");
    expect(field(/Buffer/i).value).toBe("2");
    expect(field(/Min order quantity/i).value).toBe("5");
    expect(field(/Reorder point override/i).value).toBe("12");
  });

  it.each([
    ["a non-OK answer", (i: number) => answer(i, { ok: false, status: 404, json: async () => ({ error: "Product not found" }) })],
    [
      "a network error",
      async (i: number) => {
        await act(async () => {
          reads[i].reject(new Error("offline"));
        });
      },
    ],
  ])("%s -> Couldn't load this product. and NO form", async (_label, fail) => {
    renderDialog(5);
    await fail(0);
    expect(await screen.findByText("Couldn't load this product.")).toBeInTheDocument();
    expect(screen.queryByText("Loading…")).toBeNull();
    expect(screen.queryByRole("button", { name: "Update Product" })).toBeNull();
    expect(screen.queryByLabelText(/Lead time/i)).toBeNull();
  });

  it("an answer for another id is ignored", async () => {
    const { rerender } = renderDialog(5);
    rerender(<EditProductDialog product={LIST_PRODUCTS[6] as never} open onOpenChange={jest.fn()} />);
    expect(reads.map((r) => r.url)).toEqual(["/api/products/5", "/api/products/6"]);

    await answer(0, ok(liveProduct(5, CONFIG_5)));
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Update Product" })).toBeNull();

    await answer(1, ok(liveProduct(6, { ...CONFIG_5, leadTimeDays: 30 })));
    expect(await screen.findByRole("button", { name: "Update Product" })).toBeInTheDocument();
    expect(field(/Lead time/i).value).toBe("30");
  });
});

describe("EditProductDialog -> PUT: each override compared with its mount value (MS-2-2 / OC-6)", () => {
  it("untouched -> the PUT carries NO reorderConfig key", async () => {
    await renderLoaded();
    const { url, body } = await submitAndReadPut();
    expect(url).toBe("/api/products/5");
    expect(body).not.toHaveProperty("reorderConfig");
  });

  it("clearing lead time -> leadTimeDays: null, and nothing else", async () => {
    await renderLoaded();
    fireEvent.change(field(/Lead time/i), { target: { value: "" } });
    const { body } = await submitAndReadPut();
    expect(body.reorderConfig).toEqual({ leadTimeDays: null });
  });

  it("clearing MOQ -> minOrderQuantity: 1 (not nullable), and nothing else", async () => {
    await renderLoaded();
    fireEvent.change(field(/Min order quantity/i), { target: { value: "" } });
    const { body } = await submitAndReadPut();
    expect(body.reorderConfig).toEqual({ minOrderQuantity: 1 });
  });

  it("clearing buffer and the reorder point -> null for each", async () => {
    await renderLoaded();
    fireEvent.change(field(/Buffer/i), { target: { value: "" } });
    fireEvent.change(field(/Reorder point override/i), { target: { value: "" } });
    const { body } = await submitAndReadPut();
    expect(body.reorderConfig).toEqual({ customSafetyStockDays: null, reorderPointOverride: null });
  });

  it("a changed value -> that value only; an unchanged retype is still omitted", async () => {
    await renderLoaded();
    fireEvent.change(field(/Lead time/i), { target: { value: "9" } });
    fireEvent.change(field(/Buffer/i), { target: { value: "2" } });
    const { body } = await submitAndReadPut();
    expect(body.reorderConfig).toEqual({ leadTimeDays: 9 });
  });

  it("a product with no config: setting buffer 0 sends it; MOQ left blank is omitted", async () => {
    await renderLoaded(null);
    expect(field(/Buffer/i).value).toBe("");
    fireEvent.change(field(/Buffer/i), { target: { value: "0" } });
    const { body } = await submitAndReadPut();
    expect(body.reorderConfig).toEqual({ customSafetyStockDays: 0 });
  });
});

describe("ProductForm — the comparison lives in the form, against ITS mount defaults", () => {
  const product = (reorderConfig: Overrides | null) =>
    ({ ...liveProduct(5, reorderConfig) }) as never;

  it("edit, untouched: a product WITH overrides sends no reorderConfig", async () => {
    const onSubmit = jest.fn().mockResolvedValue(undefined);
    render(<ProductForm product={product(CONFIG_5)} onSubmit={onSubmit} onCancel={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /update product/i }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0]).not.toHaveProperty("reorderConfig");
  });

  it("edit: a stored MOQ of 1, cleared, resolves to 1 again -> omitted (no change)", async () => {
    const onSubmit = jest.fn().mockResolvedValue(undefined);
    render(
      <ProductForm
        product={product({ ...CONFIG_5, minOrderQuantity: 1 })}
        onSubmit={onSubmit}
        onCancel={() => {}}
      />,
    );
    fireEvent.change(screen.getByLabelText(/Min order quantity/i), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: /update product/i }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0]).not.toHaveProperty("reorderConfig");
  });

  it("create: blank overrides -> the body carries NO reorderConfig (byte-identical to before)", async () => {
    const onSubmit = jest.fn().mockResolvedValue(undefined);
    render(<ProductForm onSubmit={onSubmit} onCancel={() => {}} />);
    fireEvent.change(screen.getByLabelText(/product name/i), { target: { value: "BPC" } });
    fireEvent.change(screen.getByLabelText(/variant label/i), { target: { value: "Vial" } });
    fireEvent.click(screen.getByRole("button", { name: /create product/i }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0]).not.toHaveProperty("reorderConfig");
  });

  it("create: typed overrides are sent as before (in the same key order)", async () => {
    const onSubmit = jest.fn().mockResolvedValue(undefined);
    render(<ProductForm onSubmit={onSubmit} onCancel={() => {}} />);
    fireEvent.change(screen.getByLabelText(/product name/i), { target: { value: "BPC" } });
    fireEvent.change(screen.getByLabelText(/variant label/i), { target: { value: "Vial" } });
    fireEvent.change(screen.getByLabelText(/Min order quantity/i), { target: { value: "1" } });
    fireEvent.change(screen.getByLabelText(/Lead time/i), { target: { value: "4" } });
    fireEvent.change(screen.getByLabelText(/Buffer/i), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: /create product/i }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const sent = onSubmit.mock.calls[0][0];
    expect(sent.reorderConfig).toEqual({ leadTimeDays: 4, customSafetyStockDays: 0, minOrderQuantity: 1 });
    expect(Object.keys(sent.reorderConfig)).toEqual([
      "leadTimeDays",
      "customSafetyStockDays",
      "minOrderQuantity",
    ]);
  });
});

describe("the products page mounts EditProductDialog per open (M-a.3)", () => {
  beforeAll(() => {
    (useSession as jest.Mock).mockReturnValue({
      data: { user: { id: "1", isAdmin: true } },
      status: "authenticated",
    });
  });

  it("no read while closed; one read per open — a reopen of the SAME product reads afresh", async () => {
    const user = userEvent.setup();
    render(<ProductsPage />);
    expect(reads).toHaveLength(0);
    expect(screen.queryByText("Edit Product")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Edit 5" }));
    expect(reads.map((r) => r.url)).toEqual(["/api/products/5"]);
    await answer(0, ok(liveProduct(5, CONFIG_5)));
    expect(field(/Lead time/i).value).toBe("7");

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByText("Edit Product")).toBeNull());

    await user.click(screen.getByRole("button", { name: "Edit 5" }));
    expect(reads.map((r) => r.url)).toEqual(["/api/products/5", "/api/products/5"]);
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    await answer(1, ok(liveProduct(5, { ...CONFIG_5, leadTimeDays: 8 })));
    expect(field(/Lead time/i).value).toBe("8");
  });
});
