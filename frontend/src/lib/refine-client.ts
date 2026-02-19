const API_BASE = "/api/refine";

export async function fetchRows(projectId: string, accessToken: string): Promise<Response> {
  return fetch(`${API_BASE}/command/core/get-rows?project=${encodeURIComponent(projectId)}`, {
    method: "GET",
    headers: {
      authorization: `Bearer ${accessToken}`
    }
  });
}
