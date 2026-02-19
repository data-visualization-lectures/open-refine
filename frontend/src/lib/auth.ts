import { ApiError } from "@/lib/api-error";

export type AuthenticatedUser = {
  id: string;
  accessToken: string;
  email?: string;
};

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new ApiError(500, `Missing environment variable: ${name}`);
  }
  return value;
}

function parseBearerToken(request: Request): string | null {
  const authHeader = request.headers.get("authorization");
  if (!authHeader) {
    return null;
  }
  const [scheme, token] = authHeader.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) {
    return null;
  }
  return token;
}

function parseCookieMap(request: Request): Map<string, string> {
  const cookieHeader = request.headers.get("cookie");
  const map = new Map<string, string>();
  if (!cookieHeader) {
    return map;
  }

  for (const part of cookieHeader.split(";")) {
    const [rawKey, ...rawValueParts] = part.trim().split("=");
    if (!rawKey || rawValueParts.length === 0) {
      continue;
    }
    map.set(rawKey, rawValueParts.join("="));
  }

  return map;
}

function looksLikeJwt(value: string): boolean {
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value);
}

function decodeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padLength = (4 - (normalized.length % 4)) % 4;
  const padded = normalized + "=".repeat(padLength);
  return Buffer.from(padded, "base64").toString("utf8");
}

function extractAccessTokenFromParsed(value: unknown): string | null {
  if (typeof value === "string") {
    return looksLikeJwt(value) ? value : null;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const token = extractAccessTokenFromParsed(item);
      if (token) {
        return token;
      }
    }
    return null;
  }

  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  const direct = record.access_token;
  if (typeof direct === "string" && direct) {
    return direct;
  }

  for (const nestedKey of ["currentSession", "session", "data"]) {
    const nested = record[nestedKey];
    const token = extractAccessTokenFromParsed(nested);
    if (token) {
      return token;
    }
  }

  return null;
}

function parseAuthTokenCookieValue(rawValue: string): string | null {
  const decoded = decodeURIComponent(rawValue);

  if (looksLikeJwt(decoded)) {
    return decoded;
  }

  const candidates = [decoded];
  if (decoded.startsWith("base64-")) {
    try {
      candidates.push(decodeBase64Url(decoded.slice("base64-".length)));
    } catch {
      // Ignore base64 parse errors and continue with other formats.
    }
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      const token = extractAccessTokenFromParsed(parsed);
      if (token) {
        return token;
      }
    } catch {
      // Not JSON; try next candidate.
    }
  }

  return null;
}

function readChunkedCookie(cookieMap: Map<string, string>, baseName: string): string | null {
  const direct = cookieMap.get(baseName);
  if (direct) {
    return direct;
  }

  const chunks: Array<{ index: number; value: string }> = [];
  for (const [key, value] of cookieMap.entries()) {
    if (!key.startsWith(`${baseName}.`)) {
      continue;
    }
    const suffix = key.slice(baseName.length + 1);
    if (!/^\d+$/.test(suffix)) {
      continue;
    }
    chunks.push({ index: Number.parseInt(suffix, 10), value });
  }

  if (!chunks.length) {
    return null;
  }

  chunks.sort((a, b) => a.index - b.index);
  return chunks.map((chunk) => chunk.value).join("");
}

function parseTokenFromSupabaseCookie(request: Request): string | null {
  const cookieMap = parseCookieMap(request);
  const directToken = cookieMap.get("sb-access-token");
  if (directToken) {
    return decodeURIComponent(directToken);
  }

  const baseNames = new Set<string>();
  for (const key of cookieMap.keys()) {
    if (!key.startsWith("sb-")) {
      continue;
    }
    const normalized = key.replace(/\.\d+$/, "");
    if (normalized.endsWith("-auth-token")) {
      baseNames.add(normalized);
    }
  }

  // Explicitly include the shared dataviz cookie name even if chunks are not yet in the map iteration.
  baseNames.add("sb-dataviz-auth-token");

  for (const baseName of baseNames) {
    const rawValue = readChunkedCookie(cookieMap, baseName);
    if (!rawValue) {
      continue;
    }
    const token = parseAuthTokenCookieValue(rawValue);
    if (token) {
      return token;
    }
  }

  return null;
}

export async function requireAuthenticatedUser(request: Request): Promise<AuthenticatedUser> {
  const accessToken = parseBearerToken(request) ?? parseTokenFromSupabaseCookie(request);
  if (!accessToken) {
    throw new ApiError(401, "Missing Supabase access token");
  }

  const supabaseUrl = requiredEnv("NEXT_PUBLIC_SUPABASE_URL");
  const supabaseAnonKey = requiredEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");

  const userResponse = await fetch(`${supabaseUrl}/auth/v1/user`, {
    method: "GET",
    headers: {
      apikey: supabaseAnonKey,
      authorization: `Bearer ${accessToken}`
    },
    cache: "no-store"
  });

  if (!userResponse.ok) {
    throw new ApiError(401, "Invalid or expired Supabase token");
  }

  const user = (await userResponse.json()) as { id?: string; email?: string };
  if (!user.id) {
    throw new ApiError(401, "Supabase user does not include id");
  }

  return {
    id: user.id,
    accessToken,
    email: user.email
  };
}
