/**
 * SSR-safe, exception-safe localStorage JSON helpers (iOS private mode,
 * quota errors, and parse failures all degrade to the fallback / no-op).
 */
export function getJSON<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function setJSON(key: string, value: unknown): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Best-effort persistence only (private mode / quota).
  }
}
