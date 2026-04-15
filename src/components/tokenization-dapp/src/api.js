export const API_BASE = import.meta.env.VITE_API_BASE ?? "/api";

async function request(path, init) {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    ...init,
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    const message = typeof payload?.error === "string" ? payload.error : `Request failed (${response.status})`;
    throw new Error(message);
  }

  return response.json();
}

export const api = {
  health: () => request("/health"),
  chatWorkspaceAgent: (payload) =>
    request("/ai/workspace-agent/chat", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  getWorkspaceAgentHistory: (sessionId) => {
    const query = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : "";
    return request(`/ai/workspace-agent/history${query}`);
  },
};
