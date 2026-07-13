/**
 * Minimal prisma stand-in for the alias-bundled smoke build. tsup aliases
 * `@/lib/prisma` to this module so the shared find_product tool graph runs end-to-end
 * WITHOUT a database. Only the methods that graph touches are provided; each returns
 * an empty/zero result. This exists ONLY to prove the bundle shape — the real sidecar
 * (T5) binds the actual @/lib/prisma singleton.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
const prismaMock: any = {
  product: {
    count: async () => 0,
    findMany: async () => [],
  },
  product_locations: {
    findMany: async () => [],
  },
  systemSetting: {
    findUnique: async () => null,
  },
};

export default prismaMock;
