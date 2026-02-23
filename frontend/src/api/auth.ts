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

let inFlightRefresh: Promise<AuthState> | null = null;
let consecutiveRefreshAuthFailures = 0;
const MAX_REFRESH_AUTH_FAILURES_BEFORE_LOGOUT = 3;

export async function authorizedFetch(
    baseUrl: string,
    path: string,
    init: RequestInit,
    auth: AuthState,
    onAuthUpdate: (next: AuthState | null) => void
) {
    const headers = new Headers(init.headers ?? {});
    headers.set("Authorization", `Bearer ${auth.accessToken}`);
    const res = await fetch(`${baseUrl}${path}`, { ...init, headers });
    if (res.status !== 401) {
        consecutiveRefreshAuthFailures = 0;
        return res;
    }

    if (!auth.refreshToken) return res;

    try {
        if (!inFlightRefresh) {
            inFlightRefresh = refresh(baseUrl, auth.refreshToken);
        }
        const refreshed = await inFlightRefresh;
        onAuthUpdate(refreshed);

        const retryHeaders = new Headers(init.headers ?? {});
        retryHeaders.set("Authorization", `Bearer ${refreshed.accessToken}`);
        const retryRes = await fetch(`${baseUrl}${path}`, { ...init, headers: retryHeaders });
        if (retryRes.status === 401 || retryRes.status === 403) {
            consecutiveRefreshAuthFailures += 1;
            if (consecutiveRefreshAuthFailures >= MAX_REFRESH_AUTH_FAILURES_BEFORE_LOGOUT) {
                onAuthUpdate(null);
            }
        } else {
            consecutiveRefreshAuthFailures = 0;
        }
        return retryRes;
    } catch (e: any) {
        const status = Number(e?.status ?? 0);
        if (status === 401 || status === 403) {
            consecutiveRefreshAuthFailures += 1;
            if (consecutiveRefreshAuthFailures >= MAX_REFRESH_AUTH_FAILURES_BEFORE_LOGOUT) {
                onAuthUpdate(null);
            }
        } else {
            // 网络抖动/超时不应导致退出登录
        }
        return res;
    } finally {
        inFlightRefresh = null;
    }
}
