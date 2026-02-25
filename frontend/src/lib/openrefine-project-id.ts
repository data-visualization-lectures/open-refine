/**
 * Utilities for extracting OpenRefine runtime project IDs from various response formats.
 * Centralised here so that all routes share the same extraction logic.
 */

/**
 * Extracts a numeric project ID from a raw string containing `project=<digits>`.
 * Useful for parsing Location headers and redirect URLs returned by OpenRefine.
 */
export function parseProjectIdFromLocation(raw: string | null): string | null {
  if (!raw) return null;
  const match = raw.match(/project=(\d+)/);
  return match?.[1] ?? null;
}

/**
 * Extracts a numeric project ID from a response body string.
 * Tries query-string format first, then JSON field names, then path format.
 */
export function parseProjectIdFromBody(raw: string): string | null {
  const fromLocation = parseProjectIdFromLocation(raw);
  if (fromLocation) return fromLocation;

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const candidates = [parsed.project, parsed.projectID, parsed.projectId];
    for (const candidate of candidates) {
      if (typeof candidate === "number" && Number.isFinite(candidate)) {
        return String(candidate);
      }
      if (typeof candidate === "string") {
        if (/^\d+$/.test(candidate)) return candidate;
        const nested = parseProjectIdFromLocation(candidate);
        if (nested) return nested;
      }
    }
  } catch {
    // not JSON
  }

  return raw.match(/\/project\?project=(\d+)/)?.[1] ?? null;
}
