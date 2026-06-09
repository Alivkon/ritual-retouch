import type { User, Generation, GenerationStatus, AuthResponse } from "./types.js";

const TOKEN_KEY = "auth_token";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

async function request<T>(
  url: string,
  options: RequestInit = {},
): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string> ?? {}),
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const resp = await fetch(url, { ...options, headers });

  if (resp.status === 401) {
    const hadToken = !!getToken();
    clearToken();
    if (hadToken) window.location.reload();
    throw new Error("Unauthorized");
  }

  const data = await resp.json() as T & { error?: string };
  if (!resp.ok) {
    throw new Error((data as { error?: string }).error ?? `HTTP ${resp.status}`);
  }
  return data;
}

// Auth
export async function register(email: string, password: string): Promise<{ message: string }> {
  return request<{ message: string }>("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
}

export async function resendVerification(email: string): Promise<{ message: string }> {
  return request<{ message: string }>("/api/auth/resend-verification", {
    method: "POST",
    body: JSON.stringify({ email }),
  });
}

export async function login(email: string, password: string): Promise<AuthResponse> {
  const resp = await request<AuthResponse>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  setToken(resp.token);
  return resp;
}

export async function logout(): Promise<void> {
  await request("/api/auth/logout", { method: "POST" }).catch(() => undefined);
  clearToken();
}

export async function getMe(): Promise<User> {
  return request<User>("/api/auth/me");
}

// Upload
export async function uploadPhoto(file: File): Promise<string> {
  const token = getToken();
  const formData = new FormData();
  formData.append("file", file);
  const resp = await fetch("/api/web/upload", {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: formData,
  });
  if (resp.status === 401) { clearToken(); window.location.reload(); throw new Error("Unauthorized"); }
  const data = await resp.json() as { url?: string; error?: string };
  if (!resp.ok) throw new Error(data.error ?? `HTTP ${resp.status}`);
  return data.url!;
}

// Generation
export async function startGeneration(
  uploadUrl: string,
  prompt: string,
): Promise<{ generation_id: number; status: string }> {
  return request("/api/web/generate", {
    method: "POST",
    body: JSON.stringify({ upload_url: uploadUrl, prompt }),
  });
}

export async function getGenerationStatus(id: number): Promise<GenerationStatus> {
  return request<GenerationStatus>(`/api/web/generation/${id}/status`);
}

export async function getGenerations(page = 0, limit = 20): Promise<Generation[]> {
  return request<Generation[]>(`/api/web/generations?page=${page}&limit=${limit}`);
}

export async function getBalance(): Promise<{
  balance: number;
  free_generations: number;
  total_generations: number;
  has_package: boolean;
  package_code: string | null;
  package_title: string | null;
  package_generations_total: number;
  package_generations_remaining: number;
}> {
  return request("/api/web/balance");
}

export async function getPayments(): Promise<{ id: number; amount: number; package_title: string | null; created_at: string }[]> {
  return request("/api/web/payments");
}

// Payments
export async function createYookassaPayment(amount: number): Promise<{ confirmation_token: string; payment_id: string }> {
  return request("/api/web/payment/yookassa", {
    method: "POST",
    body: JSON.stringify({ amount }),
  });
}

export async function confirmYookassaPayment(paymentId: string): Promise<{
  credited: boolean;
  status?: string;
  balance: number;
  package_generations_remaining: number;
  package_title: string | null;
}> {
  return request("/api/web/payment/yookassa/confirm", {
    method: "POST",
    body: JSON.stringify({ payment_id: paymentId }),
  });
}

export async function linkTelegramAccount(): Promise<{ bot_url: string; expires_in_seconds: number }> {
  return request("/api/auth/telegram-link", { method: "POST" });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
