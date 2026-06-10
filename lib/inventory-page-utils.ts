/** Auto-load stops after this many pages until the user clicks Load more. */
export const AUTO_LOAD_PAGE_LIMIT = 3;

/** Pure gate for sentinel-driven auto-loading. */
export function shouldAutoLoad(pagesLoaded: number, hasNextPage: boolean, limit: number): boolean {
  return hasNextPage && pagesLoaded < limit;
}
