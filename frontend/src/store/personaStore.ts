import {
    loadPersonasState,
    savePersonasState,
    type PersistedPersona,
} from "./persist";
import type { AuthState } from "./authStore";
import type { Persona, PersonaCreate } from "../types/persona";
import {
    createPersona,
    deletePersona,
    duplicatePersona,
    fetchPersonas,
    updatePersona,
} from "../api/personas";

function saveCached(personas: Persona[]) {
    savePersonasState({
        schemaVersion: 1,
        personas: personas as PersistedPersona[],
    });
}

function upsertPersona(personas: Persona[], next: Persona): Persona[] {
    const idx = personas.findIndex((p) => p.id === next.id);
    if (idx === -1) return [next, ...personas];
    const merged = [...personas];
    merged[idx] = next;
    return merged;
}

export function loadCachedPersonas(): Persona[] {
    const state = loadPersonasState();
    if (!state) return [];
    return state.personas as Persona[];
}

export async function syncPersonasFromRemote(
    baseUrl: string,
    auth: AuthState,
    onAuthUpdate: (next: AuthState | null) => void
): Promise<Persona[]> {
    const personas = await fetchPersonas(baseUrl, auth, onAuthUpdate);
    const local = loadCachedPersonas();
    const orderMap = new Map(local.map((p, i) => [p.id, i]));
    const merged = [...personas].sort((a, b) => {
        const ai = orderMap.get(a.id);
        const bi = orderMap.get(b.id);
        if (typeof ai === "number" && typeof bi === "number") return ai - bi;
        if (typeof ai === "number") return -1;
        if (typeof bi === "number") return 1;
        return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
    });
    saveCached(merged);
    return merged;
}

export async function createPersonaAndCache(
    baseUrl: string,
    auth: AuthState,
    onAuthUpdate: (next: AuthState | null) => void,
    payload: PersonaCreate
): Promise<Persona[]> {
    const created = await createPersona(baseUrl, auth, onAuthUpdate, payload);
    const next = upsertPersona(loadCachedPersonas(), created);
    saveCached(next);
    return next;
}

export async function updatePersonaAndCache(
    baseUrl: string,
    auth: AuthState,
    onAuthUpdate: (next: AuthState | null) => void,
    id: string,
    payload: Partial<Persona>
): Promise<Persona[]> {
    const updated = await updatePersona(baseUrl, auth, onAuthUpdate, id, payload);
    const next = upsertPersona(loadCachedPersonas(), updated);
    saveCached(next);
    return next;
}

export async function deletePersonaAndCache(
    baseUrl: string,
    auth: AuthState,
    onAuthUpdate: (next: AuthState | null) => void,
    id: string
): Promise<Persona[]> {
    await deletePersona(baseUrl, auth, onAuthUpdate, id);
    const next = loadCachedPersonas().filter((p) => p.id !== id);
    saveCached(next);
    return next;
}

export async function duplicatePersonaAndCache(
    baseUrl: string,
    auth: AuthState,
    onAuthUpdate: (next: AuthState | null) => void,
    id: string
): Promise<Persona[]> {
    const duplicated = await duplicatePersona(baseUrl, auth, onAuthUpdate, id);
    const next = upsertPersona(loadCachedPersonas(), duplicated);
    saveCached(next);
    return next;
}

export function reorderCachedPersonas(fromId: string, toId: string): Persona[] {
    if (fromId === toId) return loadCachedPersonas();
    const list = loadCachedPersonas();
    const fromIdx = list.findIndex((p) => p.id === fromId);
    const toIdx = list.findIndex((p) => p.id === toId);
    if (fromIdx === -1 || toIdx === -1) return list;
    const next = [...list];
    const [moved] = next.splice(fromIdx, 1);
    next.splice(toIdx, 0, moved);
    saveCached(next);
    return next;
}
