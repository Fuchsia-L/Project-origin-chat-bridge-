// frontend/src/store/persist.ts
export type PersistedSettings = {
    system_prompt: string;
    model: string;
    temperature: number;
    stream: boolean;
};

export type PersistedMessage = {
    role: "user" | "assistant" | "system";
    content: string;
    meta?: any;
};

export type PersistedStateV1 = {
    schemaVersion: 1;
    updatedAt: number;
    messages: PersistedMessage[];
    settings: PersistedSettings;
};

export type PersistedSession = {
    id: string;
    title: string;
    createdAt: number;
    updatedAt: number;
    messages: PersistedMessage[];
    settings: PersistedSettings;
};

export type PersistedSessionsStateV1 = {
    schemaVersion: 1;
    activeId: string;
    sessions: PersistedSession[];
};

export type PersistedSyncStateV1 = {
    schemaVersion: 1;
    lastSyncAt: number;
};

let storageNamespace = "global";

const LEGACY_STORAGE_KEY = "project-origin:v1";

function withNamespace(key: string) {
    return `${key}:${storageNamespace}`;
}

const SESSIONS_STORAGE_KEY = "project-origin:sessions:v1";
const MODELS_STORAGE_KEY = "project-origin:models:v1";
const SYNC_STORAGE_KEY = "project-origin:sync:v1";

export function setStorageNamespace(value: string | null) {
    storageNamespace = value?.trim() ? value.trim() : "global";
}

export function loadPersistedState(): PersistedStateV1 | null {
    try {
        const raw = localStorage.getItem(withNamespace(LEGACY_STORAGE_KEY));
        if (!raw) return null;

        const parsed = JSON.parse(raw) as PersistedStateV1;
        if (!parsed || parsed.schemaVersion !== 1) return null;
        if (!Array.isArray(parsed.messages)) return null;
        if (!parsed.settings) return null;

        return parsed;
    } catch {
        return null;
    }
}

export function savePersistedState(state: PersistedStateV1) {
    try {
        localStorage.setItem(withNamespace(LEGACY_STORAGE_KEY), JSON.stringify(state));
    } catch {
        // ignore
    }
}

export function clearPersistedState() {
    try {
        localStorage.removeItem(withNamespace(LEGACY_STORAGE_KEY));
    } catch {
        // ignore
    }
}

export function loadSessionsState(): PersistedSessionsStateV1 | null {
    try {
        const raw = localStorage.getItem(withNamespace(SESSIONS_STORAGE_KEY));
        if (!raw) return null;

        const parsed = JSON.parse(raw) as PersistedSessionsStateV1;
        if (!parsed || parsed.schemaVersion !== 1) return null;
        if (!parsed.activeId) return null;
        if (!Array.isArray(parsed.sessions)) return null;

        return parsed;
    } catch {
        return null;
    }
}

export function saveSessionsState(state: PersistedSessionsStateV1) {
    try {
        localStorage.setItem(withNamespace(SESSIONS_STORAGE_KEY), JSON.stringify(state));
    } catch {
        // ignore
    }
}

export function loadSyncState(): PersistedSyncStateV1 | null {
    try {
        const raw = localStorage.getItem(withNamespace(SYNC_STORAGE_KEY));
        if (!raw) return null;
        const parsed = JSON.parse(raw) as PersistedSyncStateV1;
        if (!parsed || parsed.schemaVersion !== 1) return null;
        if (typeof parsed.lastSyncAt !== "number") return null;
        return parsed;
    } catch {
        return null;
    }
}

export function saveSyncState(state: PersistedSyncStateV1) {
    try {
        localStorage.setItem(withNamespace(SYNC_STORAGE_KEY), JSON.stringify(state));
    } catch {
        // ignore
    }
}

export function clearSyncState() {
    try {
        localStorage.removeItem(withNamespace(SYNC_STORAGE_KEY));
    } catch {
        // ignore
    }
}

export function loadModelList(): string[] | null {
    try {
        const raw = localStorage.getItem(withNamespace(MODELS_STORAGE_KEY));
        if (!raw) return null;
        const parsed = JSON.parse(raw) as string[];
        if (!Array.isArray(parsed)) return null;
        return parsed.filter((m) => typeof m === "string" && m.trim().length > 0);
    } catch {
        return null;
    }
}

export function saveModelList(models: string[]) {
    try {
        localStorage.setItem(withNamespace(MODELS_STORAGE_KEY), JSON.stringify(models));
    } catch {
        // ignore
    }
}

export function createThrottledSaver<T>(fn: (value: T) => void, delay = 300) {
    let timer: number | null = null;
    let lastValue: T | null = null;

    return (value: T) => {
        lastValue = value;
        if (timer) window.clearTimeout(timer);
        timer = window.setTimeout(() => {
            timer = null;
            if (lastValue !== null) fn(lastValue);
        }, delay);
    };
}

export function buildPersistedState(args: {
    messages: PersistedMessage[];
    settings: PersistedSettings;
}): PersistedStateV1 {
    return {
        schemaVersion: 1,
        updatedAt: Date.now(),
        messages: args.messages,
        settings: args.settings,
    };
}
