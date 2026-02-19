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

function parseTokenFromSupabaseCookie(request: Request): string | null {
  const cookieMap = parseCookieMap(request);
  const directToken = cookieMap.get("sb-access-token");
  if (directToken) {
    return decodeURIComponent(directToken);
  }

  for (const [key, value] of cookieMap.entries()) {
    if (!key.startsWith("sb-") || !key.endsWith("-auth-token")) {
      continue;
    }

    try {
      const decoded = decodeURIComponent(value);
      const parsed = JSON.parse(decoded) as { access_token?: string } | Array<{ access_token?: string }>;
      if (Array.isArray(parsed)) {
        const token = parsed[0]?.access_token;
        if (token) {
          return token;
        }
      } else if (parsed.access_token) {
        return parsed.access_token;
      }
    } catch {
      // Skip cookies that are not in JSON form.
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
