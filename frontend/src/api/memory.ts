import type { AuthState } from "../store/authStore";
import { authorizedFetch } from "./auth";

export type PersonaMemory = {
    id: string;
    user_id: string;
    persona_id: string;
    memory_type: string;
    content: string;
    confidence: number;
    is_active: boolean;
    needs_review: boolean;
    source_session_id?: string | null;
    review_hints?: string[] | null;
    created_at: string;
    updated_at: string;
};

export type PersonaMemoryPatch = {
    memory_type?: string;
    content?: string;
    confidence?: number;
    is_active?: boolean;
    needs_review?: boolean;
};

export async function compressSession(
    baseUrl: string,
    auth: AuthState,
    onAuthUpdate: (next: AuthState | null) => void,
    sessionId: string
): Promise<{ session_id: string; summary_text: string; token_count: number }> {
    const res = await authorizedFetch(
        baseUrl,
        `/api/memory/sessions/${sessionId}/compress`,
        { method: "POST" },
        auth,
        onAuthUpdate
    );
    if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        const message = data?.message || res.statusText || "全局压缩失败";
        throw new Error(message);
    }
    return res.json();
}

export async function fetchPersonaMemories(
    baseUrl: string,
    auth: AuthState,
    onAuthUpdate: (next: AuthState | null) => void,
    personaId: string,
    filters?: { is_active?: boolean; needs_review?: boolean }
): Promise<PersonaMemory[]> {
    const qs = new URLSearchParams();
    if (typeof filters?.is_active === "boolean") {
        qs.set("is_active", String(filters.is_active));
    }
    if (typeof filters?.needs_review === "boolean") {
        qs.set("needs_review", String(filters.needs_review));
    }
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    const res = await authorizedFetch(
        baseUrl,
        `/api/memory/personas/${personaId}/memories${suffix}`,
        { method: "GET" },
        auth,
        onAuthUpdate
    );
    if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        const message = data?.message || res.statusText || "获取角色记忆失败";
        throw new Error(message);
    }
    return res.json();
}

export async function approvePersonaMemory(
    baseUrl: string,
    auth: AuthState,
    onAuthUpdate: (next: AuthState | null) => void,
    personaId: string,
    memoryId: string
): Promise<PersonaMemory> {
    const res = await authorizedFetch(
        baseUrl,
        `/api/memory/personas/${personaId}/memories/${memoryId}/approve`,
        { method: "POST" },
        auth,
        onAuthUpdate
    );
    if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        const message = data?.message || res.statusText || "审批通过失败";
        throw new Error(message);
    }
    return res.json();
}

export async function rejectPersonaMemory(
    baseUrl: string,
    auth: AuthState,
    onAuthUpdate: (next: AuthState | null) => void,
    personaId: string,
    memoryId: string
): Promise<PersonaMemory> {
    const res = await authorizedFetch(
        baseUrl,
        `/api/memory/personas/${personaId}/memories/${memoryId}/reject`,
        { method: "POST" },
        auth,
        onAuthUpdate
    );
    if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        const message = data?.message || res.statusText || "审批拒绝失败";
        throw new Error(message);
    }
    return res.json();
}

export async function updatePersonaMemory(
    baseUrl: string,
    auth: AuthState,
    onAuthUpdate: (next: AuthState | null) => void,
    personaId: string,
    memoryId: string,
    patch: PersonaMemoryPatch
): Promise<PersonaMemory> {
    const res = await authorizedFetch(
        baseUrl,
        `/api/memory/personas/${personaId}/memories/${memoryId}`,
        {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(patch),
        },
        auth,
        onAuthUpdate
    );
    if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        const message = data?.message || res.statusText || "更新角色记忆失败";
        throw new Error(message);
    }
    return res.json();
}

export async function deletePersonaMemory(
    baseUrl: string,
    auth: AuthState,
    onAuthUpdate: (next: AuthState | null) => void,
    personaId: string,
    memoryId: string
): Promise<void> {
    const res = await authorizedFetch(
        baseUrl,
        `/api/memory/personas/${personaId}/memories/${memoryId}`,
        { method: "DELETE" },
        auth,
        onAuthUpdate
    );
    if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        const message = data?.message || res.statusText || "删除角色记忆失败";
        throw new Error(message);
    }
}
