import type { AuthState } from "../store/authStore";
import type { Persona, PersonaCreate } from "../types/persona";
import { authorizedFetch } from "./auth";

export async function fetchPersonas(
    baseUrl: string,
    auth: AuthState,
    onAuthUpdate: (next: AuthState | null) => void
): Promise<Persona[]> {
    const res = await authorizedFetch(baseUrl, "/api/personas", { method: "GET" }, auth, onAuthUpdate);
    if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        const message = data?.message || res.statusText || "获取角色失败";
        throw new Error(message);
    }
    const data = await res.json();
    return data.personas ?? [];
}

export async function createPersona(
    baseUrl: string,
    auth: AuthState,
    onAuthUpdate: (next: AuthState | null) => void,
    payload: PersonaCreate
): Promise<Persona> {
    const res = await authorizedFetch(
        baseUrl,
        "/api/personas",
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        },
        auth,
        onAuthUpdate
    );
    if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        const message = data?.message || res.statusText || "创建角色失败";
        throw new Error(message);
    }
    return res.json();
}

export async function updatePersona(
    baseUrl: string,
    auth: AuthState,
    onAuthUpdate: (next: AuthState | null) => void,
    id: string,
    payload: Partial<Persona>
): Promise<Persona> {
    const res = await authorizedFetch(
        baseUrl,
        `/api/personas/${id}`,
        {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        },
        auth,
        onAuthUpdate
    );
    if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        const message = data?.message || res.statusText || "更新角色失败";
        throw new Error(message);
    }
    return res.json();
}

export async function deletePersona(
    baseUrl: string,
    auth: AuthState,
    onAuthUpdate: (next: AuthState | null) => void,
    id: string
): Promise<void> {
    const res = await authorizedFetch(
        baseUrl,
        `/api/personas/${id}`,
        { method: "DELETE" },
        auth,
        onAuthUpdate
    );
    if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        const message = data?.message || res.statusText || "删除角色失败";
        throw new Error(message);
    }
}

export async function duplicatePersona(
    baseUrl: string,
    auth: AuthState,
    onAuthUpdate: (next: AuthState | null) => void,
    id: string
): Promise<Persona> {
    const res = await authorizedFetch(
        baseUrl,
        `/api/personas/${id}/duplicate`,
        { method: "POST" },
        auth,
        onAuthUpdate
    );
    if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        const message = data?.message || res.statusText || "复制角色失败";
        throw new Error(message);
    }
    return res.json();
}
