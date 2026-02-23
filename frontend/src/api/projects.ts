import type { AuthState } from "../store/authStore";
import { authorizedFetch } from "./auth";

export type Project = {
    id: string;
    user_id: string;
    name: string;
    project_type_id?: string | null;
    context_doc: Record<string, any>;
    created_at: string;
    updated_at: string;
};

export async function fetchProjects(
    baseUrl: string,
    auth: AuthState,
    onAuthUpdate: (next: AuthState | null) => void
): Promise<Project[]> {
    const res = await authorizedFetch(baseUrl, "/api/projects", { method: "GET" }, auth, onAuthUpdate);
    if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.message || res.statusText || "加载项目失败");
    }
    const data = await res.json();
    return Array.isArray(data) ? data : [];
}

export async function createProject(
    baseUrl: string,
    auth: AuthState,
    onAuthUpdate: (next: AuthState | null) => void,
    payload: {
        name: string;
        context_doc?: Record<string, any>;
        project_type_id?: string | null;
    }
): Promise<Project> {
    const res = await authorizedFetch(
        baseUrl,
        "/api/projects",
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
        throw new Error(data?.message || res.statusText || "创建项目失败");
    }
    return res.json();
}
