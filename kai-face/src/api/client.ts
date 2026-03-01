function resolveApiBase(): string {
  if (typeof window !== "undefined" && window.location.hostname !== "localhost") {
    return `${window.location.protocol}//${window.location.host}/api/ava`;
  }
  return "http://localhost:3001/api/ava";
}

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem("kai_token");
  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

export async function apiGet<T = unknown>(path: string): Promise<T> {
  const res = await fetch(`${resolveApiBase()}${path}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function apiPost<T = unknown>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${resolveApiBase()}${path}`, {
    method: "POST",
    headers: authHeaders(),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function apiPut<T = unknown>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${resolveApiBase()}${path}`, {
    method: "PUT",
    headers: authHeaders(),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function apiPatch<T = unknown>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${resolveApiBase()}${path}`, {
    method: "PATCH",
    headers: authHeaders(),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function apiDelete<T = unknown>(path: string): Promise<T> {
  const res = await fetch(`${resolveApiBase()}${path}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return res.json();
}

