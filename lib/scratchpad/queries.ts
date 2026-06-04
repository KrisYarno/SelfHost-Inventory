import prisma from "@/lib/prisma";

export async function getScratchpadBoard() {
  const products = await prisma.product.findMany({
    where: { deletedAt: null, scratchpadPrices: { some: {} } },
    select: {
      id: true,
      name: true,
      baseName: true,
      variant: true,
      approvalStatus: true,
      scratchpadPrices: {
        orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
        include: { updatedByUser: { select: { id: true, username: true } } },
      },
    },
  });
  // Sort products by most-recent row edit (desc), productId asc as a deterministic tiebreak.
  return products
    .map((p) => {
      const lastEditedAt = p.scratchpadPrices.reduce<Date | null>(
        (max, r) => (!max || r.updatedAt > max ? r.updatedAt : max),
        null,
      );
      return { ...p, lastEditedAt };
    })
    .sort((a, b) => {
      const at = a.lastEditedAt?.getTime() ?? 0;
      const bt = b.lastEditedAt?.getTime() ?? 0;
      return bt - at || a.id - b.id;
    });
}

export async function getLabelSuggestions(q?: string) {
  const rows = await prisma.productScratchpadPrice.findMany({
    where: { product: { deletedAt: null }, ...(q ? { label: { contains: q } } : {}) },
    distinct: ["label"],
    select: { label: true },
    take: 20,
    orderBy: { label: "asc" },
  });
  return rows.map((r) => r.label);
}
