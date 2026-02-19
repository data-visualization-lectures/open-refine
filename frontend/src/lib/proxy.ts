import { ApiError } from "@/lib/api-error";

const ALLOWED_COMMANDS = new Set([
  "get-all-project-metadata",
  "get-project-metadata",
  "get-rows",
  "get-columns",
  "apply-operations",
  "get-models",
  "compute-facets",
  "export-rows",
  "delete-project",
  "get-csrf-token"
]);

const PROJECT_REQUIRED_COMMANDS = new Set([
  "get-project-metadata",
  "get-rows",
  "get-columns",
  "apply-operations",
  "get-models",
  "compute-facets",
  "export-rows",
  "delete-project"
]);

const HOP_BY_HOP_RESPONSE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);

const OPENREFINE_COOKIE_ALLOW_LIST = [
  /^JSESSIONID$/i,
  /^host$/i,
  /^refine\./i,
  /^csrf/i
];

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new ApiError(500, `Missing environment variable: ${name}`);
  }
  return value;
}

export function resolveCommand(pathSegments: string[]): string {
  if (!pathSegments.length) {
    throw new ApiError(404, "Missing command path");
  }

  const normalized = pathSegments.filter(Boolean);
  if (normalized.length >= 3 && normalized[0] === "command" && normalized[1] === "core") {
    return normalized[2];
  }

  return normalized[normalized.length - 1];
}

export function assertAllowedCommand(command: string): void {
  if (!ALLOWED_COMMANDS.has(command)) {
    throw new ApiError(403, `Command not allowed: ${command}`);
  }
}

export function requiresProjectOwnership(command: string): boolean {
  return PROJECT_REQUIRED_COMMANDS.has(command);
}

export function parseProjectId(requestUrl: string): string | null {
  const url = new URL(requestUrl);
  return url.searchParams.get("project");
}

export function buildBackendUrl(pathSegments: string[], requestUrl: string): URL {
  const backend = requiredEnv("OPENREFINE_BACKEND_URL");
  const incomingUrl = new URL(requestUrl);
  const path = `/${pathSegments.join("/")}`;
  const targetUrl = new URL(path, backend);
  targetUrl.search = incomingUrl.search;
  return targetUrl;
}

export function buildBackendHeaders(request: Request): Headers {
  const headers = new Headers();
  const sharedSecret = requiredEnv("OPENREFINE_SHARED_SECRET");

  headers.set("x-openrefine-proxy-secret", sharedSecret);
  headers.set("accept", request.headers.get("accept") ?? "*/*");

  const contentType = request.headers.get("content-type");
  if (contentType) {
    headers.set("content-type", contentType);
  }

  const xToken = request.headers.get("x-token");
  if (xToken) {
    headers.set("x-token", xToken);
  }

  const cookie = request.headers.get("cookie");
  const filteredCookie = sanitizeOpenRefineCookieHeader(cookie);
  if (filteredCookie) {
    headers.set("cookie", filteredCookie);
  }

  return headers;
}

export function sanitizeOpenRefineCookieHeader(rawCookie: string | null): string | null {
  if (!rawCookie) {
    return null;
  }

  const allowedPairs: string[] = [];
  for (const token of rawCookie.split(";")) {
    const trimmed = token.trim();
    if (!trimmed) {
      continue;
    }
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex <= 0) {
      continue;
    }
    const name = trimmed.slice(0, eqIndex).trim();
    if (OPENREFINE_COOKIE_ALLOW_LIST.some((pattern) => pattern.test(name))) {
      allowedPairs.push(trimmed);
    }
  }

  if (allowedPairs.length === 0) {
    return null;
  }

  return allowedPairs.join("; ");
}

function parseCsrfToken(rawBody: string): string | null {
  const trimmed = rawBody.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed) as { token?: string };
    if (parsed.token) {
      return parsed.token;
    }
  } catch {
    // ignore json parse errors and fall back to plain text
  }

  return trimmed.replace(/^"+|"+$/g, "");
}

export async function ensureCsrfHeader(request: Request, headers: Headers, method: string): Promise<void> {
  const normalizedMethod = method.toUpperCase();
  if (normalizedMethod === "GET" || normalizedMethod === "HEAD" || normalizedMethod === "OPTIONS") {
    return;
  }

  if (headers.get("x-token")) {
    return;
  }

  const backend = requiredEnv("OPENREFINE_BACKEND_URL");
  const csrfUrl = new URL("/command/core/get-csrf-token", backend);
  const tokenResponse = await fetch(csrfUrl, {
    method: "GET",
    headers: {
      "x-openrefine-proxy-secret": headers.get("x-openrefine-proxy-secret") ?? "",
      cookie: headers.get("cookie") ?? ""
    },
    cache: "no-store"
  });

  if (!tokenResponse.ok) {
    throw new ApiError(502, `Failed to fetch CSRF token: ${tokenResponse.status}`);
  }

  const tokenBody = await tokenResponse.text();
  const csrfToken = parseCsrfToken(tokenBody);
  if (!csrfToken) {
    throw new ApiError(502, "CSRF token response was empty");
  }
  headers.set("x-token", csrfToken);

  const setCookie = tokenResponse.headers.get("set-cookie");
  if (setCookie) {
    const existing = headers.get("cookie");
    if (!existing) {
      headers.set("cookie", setCookie.split(";")[0]);
    }
  }
}

export function parseMaxUploadSizeMb(): number {
  const raw = process.env.MAX_UPLOAD_SIZE_MB ?? "100";
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    throw new ApiError(500, "MAX_UPLOAD_SIZE_MB must be a positive integer");
  }
  return parsed;
}

export function parseMaxProjectAgeHours(): number {
  const raw = process.env.MAX_PROJECT_AGE_HOURS ?? "24";
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    throw new ApiError(500, "MAX_PROJECT_AGE_HOURS must be a positive integer");
  }
  return parsed;
}

export function assertCronAuthorization(request: Request): void {
  const expected = requiredEnv("CRON_SECRET");
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token || token !== expected) {
    throw new ApiError(401, "Invalid cron token");
  }
}

export async function relayBackendResponse(response: Response): Promise<Response> {
  const headers = new Headers();
  for (const [key, value] of response.headers.entries()) {
    if (!HOP_BY_HOP_RESPONSE_HEADERS.has(key.toLowerCase())) {
      headers.append(key, value);
    }
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}
