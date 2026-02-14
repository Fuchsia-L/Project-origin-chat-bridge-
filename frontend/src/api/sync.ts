import type { AuthState } from "../store/authStore";
import type { SessionPayload } from "../store/chatStore";
import { authorizedFetch } from "./auth";

export async function pullSessions(
    baseUrl: string,
    auth: AuthState,
    onAuthUpdate: (next: AuthState) => void,
    since: number
): Promise<SessionPayload[]> {
    const res = await authorizedFetch(
        baseUrl,
        "/api/sessions/pull",
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ since }),
        },
        auth,
        onAuthUpdate
    );
    if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        const message = data?.message || res.statusText || "同步失败";
        throw new Error(message);
    }
    const data = await res.json();
    return data.sessions ?? [];
}

export async function pushSessions(
    baseUrl: string,
    auth: AuthState,
    onAuthUpdate: (next: AuthState) => void,
    sessions: SessionPayload[]
): Promise<{ accepted: string[]; conflicts: string[] }> {
    const res = await authorizedFetch(
        baseUrl,
        "/api/sessions/push",
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sessions }),
        },
        auth,
        onAuthUpdate
    );
    if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        const message = data?.message || res.statusText || "同步失败";
        throw new Error(message);
    }
    return res.json();
}
