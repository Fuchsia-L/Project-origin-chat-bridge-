export type AuthUser = {
    id: string;
    email: string;
};

export type AuthState = {
    accessToken: string;
    refreshToken: string;
    user: AuthUser;
};

const AUTH_STORAGE_KEY = "project-origin:auth:v1";

export function loadAuthState(): AuthState | null {
    try {
        const raw = localStorage.getItem(AUTH_STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as AuthState;
        if (!parsed?.accessToken || !parsed?.refreshToken || !parsed?.user?.id) {
            return null;
        }
        return parsed;
    } catch {
        return null;
    }
}

export function saveAuthState(state: AuthState) {
    try {
        localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(state));
    } catch {
        // ignore
    }
}

export function clearAuthState() {
    try {
        localStorage.removeItem(AUTH_STORAGE_KEY);
    } catch {
        // ignore
    }
}
