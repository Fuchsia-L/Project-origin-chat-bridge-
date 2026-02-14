import type { AuthState, AuthUser } from "../store/authStore";

export type AuthResponse = {
    access_token: string;
    refresh_token: string;
    user: AuthUser;
};

export type AuthError = Error & { status?: number };

async function parseAuthResponse(res: Response): Promise<AuthState> {
    if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        const message = data?.message || res.statusText || "请求失败";
        const err = new Error(message) as AuthError;
        err.status = res.status;
        throw err;
    }
    const data = (await res.json()) as AuthResponse;
    return {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        user: data.user,
    };
}

export async function register(baseUrl: string, email: string, password: string) {
    const res = await fetch(`${baseUrl}/api/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
    });
    return parseAuthResponse(res);
}

export async function login(baseUrl: string, email: string, password: string) {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
    });
    return parseAuthResponse(res);
}

export async function refresh(baseUrl: string, refreshToken: string) {
    const res = await fetch(`${baseUrl}/api/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: refreshToken }),
    });
    return parseAuthResponse(res);
}

export async function logout(baseUrl: string, refreshToken: string) {
    await fetch(`${baseUrl}/api/auth/logout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: refreshToken }),
    });
}

export async function authorizedFetch(
    baseUrl: string,
    path: string,
    init: RequestInit,
    auth: AuthState,
    onAuthUpdate: (next: AuthState) => void
) {
    const headers = new Headers(init.headers ?? {});
    headers.set("Authorization", `Bearer ${auth.accessToken}`);
    const res = await fetch(`${baseUrl}${path}`, { ...init, headers });
    if (res.status !== 401) return res;

    if (!auth.refreshToken) return res;

    const refreshed = await refresh(baseUrl, auth.refreshToken);
    onAuthUpdate(refreshed);

    const retryHeaders = new Headers(init.headers ?? {});
    retryHeaders.set("Authorization", `Bearer ${refreshed.accessToken}`);
    return fetch(`${baseUrl}${path}`, { ...init, headers: retryHeaders });
}
