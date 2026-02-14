// frontend/src/store/chatStore.ts
import type {
    PersistedMessage,
    PersistedSession,
    PersistedSessionsStateV1,
    PersistedSettings,
} from "./persist";
import {
    createThrottledSaver,
    loadPersistedState,
    loadSessionsState,
    loadSyncState,
    clearSyncState,
    saveSessionsState,
    saveSyncState,
} from "./persist";



export type UsageInfo = {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;

    // 兼容部分供应商字段
    prompt_tokens?: number;
    completion_tokens?: number;
    reasoning_tokens?: number;
};

export type ChatMessage = {
    role: "user" | "assistant";
    content: string;
    meta?: {
        isLoading?: boolean;
        isStreaming?: boolean;
        isAborted?: boolean;
        isError?: boolean;
        streamId?: string;
        request_id?: string;
        usage?: UsageInfo;
        model?: string;
        raw?: any;
        thinking?: string;
        variants?: Array<{
            content: string;
            model?: string;
            usage?: UsageInfo;
            thinking?: string;
            raw?: any;
        }>;
        activeVariantIndex?: number;
    };
};

export type ChatSettings = {
    system_prompt: string;
    model: string;
    temperature: number;
    stream: boolean;
};

export type SessionInfo = {
    id: string;
    title: string;
    createdAt: number;
    updatedAt: number;
};

export type SessionPayload = {
    id: string;
    title: string;
    createdAt: number;
    updatedAt: number;
    messages: PersistedMessage[];
    settings: PersistedSettings;
};

// ===== 默认值（你之前统一到 Gemini，这里保留） =====
export const defaultSettings: ChatSettings = {
    system_prompt: "",
    model: "gemini-3-pro-preview-11-2025",
    temperature: 0.7,
    stream: true,
};

export function toPersistedMessages(messages: ChatMessage[]): PersistedMessage[] {
    // 不保存 loading
    return messages
        .filter((m) => !m.meta?.isLoading)
        .map((m) => ({
            role: m.role,
            content: m.content,
            // meta 可选：如果你不想持久化 debug，可去掉这一行
            meta: m.meta,
        }));
}

export function fromPersistedMessages(messages: PersistedMessage[]): ChatMessage[] {
    // 恢复时同样过滤 loading（双保险）
    return messages
        .filter((m) => !(m.meta && (m.meta as any).isLoading))
        .map((m) => ({
            role: m.role === "system" ? "assistant" : (m.role as "user" | "assistant"),
            content: m.content ?? "",
            meta: m.meta,
        }));
}

export function toPersistedSettings(s: ChatSettings): PersistedSettings {
    return {
        system_prompt: s.system_prompt,
        model: s.model,
        temperature: s.temperature,
        stream: s.stream ?? true,
    };
}

export function applyPersistedSettings(s: PersistedSettings): ChatSettings {
    return {
        system_prompt: s.system_prompt ?? defaultSettings.system_prompt,
        model: s.model ?? defaultSettings.model,
        temperature:
            typeof s.temperature === "number" ? s.temperature : defaultSettings.temperature,
        stream: typeof s.stream === "boolean" ? s.stream : defaultSettings.stream,
    };
}

function buildSessionInfo(s: PersistedSession): SessionInfo {
    return {
        id: s.id,
        title: s.title,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
    };
}

function ensureSessionsState(): PersistedSessionsStateV1 {
    const existing = loadSessionsState();
    if (existing && existing.sessions.length > 0) return existing;

    const legacy = loadPersistedState();
    if (legacy) {
        const now = Date.now();
        const id = `s_${legacy.updatedAt || now}`;
        const migrated: PersistedSessionsStateV1 = {
            schemaVersion: 1,
            activeId: id,
            sessions: [
                {
                    id,
                    title: "会话 1",
                    createdAt: legacy.updatedAt || now,
                    updatedAt: legacy.updatedAt || now,
                    messages: legacy.messages,
                    settings: legacy.settings,
                },
            ],
        };
        saveSessionsState(migrated);
        return migrated;
    }

    const now = Date.now();
    const id = `s_${now}`;
    const fresh: PersistedSessionsStateV1 = {
        schemaVersion: 1,
        activeId: id,
        sessions: [
            {
                id,
                title: "会话 1",
                createdAt: now,
                updatedAt: now,
                messages: [],
                settings: toPersistedSettings(defaultSettings),
            },
        ],
    };
    saveSessionsState(fresh);
    return fresh;
}

function readActiveSession(state: PersistedSessionsStateV1): PersistedSession {
    const active =
        state.sessions.find((s) => s.id === state.activeId) ?? state.sessions[0];
    if (active.id !== state.activeId) {
        state.activeId = active.id;
        saveSessionsState(state);
    }
    return active;
}

function updateSession(
    state: PersistedSessionsStateV1,
    sessionId: string,
    updater: (s: PersistedSession) => void
) {
    const target = state.sessions.find((s) => s.id === sessionId);
    if (!target) return;
    updater(target);
}

// ====== 供 Home.tsx 调用的持久化 API ======

export function loadChatState(): {
    messages: ChatMessage[];
    settings: ChatSettings;
    sessions: SessionInfo[];
    activeId: string;
} {
    const state = ensureSessionsState();
    const active = readActiveSession(state);

    return {
        messages: fromPersistedMessages(active.messages),
        settings: applyPersistedSettings(active.settings),
        sessions: state.sessions.map(buildSessionInfo),
        activeId: state.activeId,
    };
}

// 节流保存函数（300ms）
const throttledSave = createThrottledSaver(
    (payload: { sessionId: string; messages: ChatMessage[]; settings: ChatSettings }) => {
        const state = ensureSessionsState();
        updateSession(state, payload.sessionId, (s) => {
            s.messages = toPersistedMessages(payload.messages);
            s.settings = toPersistedSettings(payload.settings);
            s.updatedAt = Date.now();
        });
        saveSessionsState(state);
    },
    300
);

export function saveChatState(payload: {
    messages: ChatMessage[];
    settings: ChatSettings;
    sessionId?: string;
}) {
    const state = ensureSessionsState();
    const sessionId = payload.sessionId ?? state.activeId;
    throttledSave({ sessionId, messages: payload.messages, settings: payload.settings });
}

export function saveSessionStateImmediate(payload: {
    sessionId: string;
    messages: ChatMessage[];
    settings: ChatSettings;
}) {
    const state = ensureSessionsState();
    updateSession(state, payload.sessionId, (s) => {
        s.messages = toPersistedMessages(payload.messages);
        s.settings = toPersistedSettings(payload.settings);
        s.updatedAt = Date.now();
    });
    saveSessionsState(state);
}

export function appendAssistantToSession(payload: {
    sessionId: string;
    assistantMessage: ChatMessage;
}) {
    const state = ensureSessionsState();
    updateSession(state, payload.sessionId, (s) => {
        const next = [...fromPersistedMessages(s.messages), payload.assistantMessage];
        s.messages = toPersistedMessages(next);
        s.updatedAt = Date.now();
    });
    saveSessionsState(state);
}

export function updateStreamingMessageInSession(payload: {
    sessionId: string;
    streamId: string;
    updater: (m: ChatMessage) => ChatMessage;
}) {
    const state = ensureSessionsState();
    updateSession(state, payload.sessionId, (s) => {
        const msgs = fromPersistedMessages(s.messages);
        const idx = msgs.findIndex((m) => m.meta?.streamId === payload.streamId);
        if (idx === -1) return;
        msgs[idx] = payload.updater(msgs[idx]);
        s.messages = toPersistedMessages(msgs);
        s.updatedAt = Date.now();
    });
    saveSessionsState(state);
}

export function clearChatState(): {
    messages: ChatMessage[];
    settings: ChatSettings;
    sessions: SessionInfo[];
    activeId: string;
} {
    const state = ensureSessionsState();
    const active = readActiveSession(state);
    active.messages = [];
    active.updatedAt = Date.now();
    saveSessionsState(state);

    return {
        messages: [],
        settings: applyPersistedSettings(active.settings),
        sessions: state.sessions.map(buildSessionInfo),
        activeId: state.activeId,
    };
}

export function createSession(): {
    messages: ChatMessage[];
    settings: ChatSettings;
    sessions: SessionInfo[];
    activeId: string;
} {
    const state = ensureSessionsState();
    const now = Date.now();
    const id = `s_${now}`;
    const title = `会话 ${state.sessions.length + 1}`;

    state.sessions.unshift({
        id,
        title,
        createdAt: now,
        updatedAt: now,
        messages: [],
        settings: toPersistedSettings(defaultSettings),
    });
    state.activeId = id;
    saveSessionsState(state);

    return {
        messages: [],
        settings: defaultSettings,
        sessions: state.sessions.map(buildSessionInfo),
        activeId: state.activeId,
    };
}

export function switchSession(id: string): {
    messages: ChatMessage[];
    settings: ChatSettings;
    sessions: SessionInfo[];
    activeId: string;
} {
    const state = ensureSessionsState();
    const target = state.sessions.find((s) => s.id === id);
    if (!target) {
        return loadChatState();
    }

    state.activeId = id;
    saveSessionsState(state);

    return {
        messages: fromPersistedMessages(target.messages),
        settings: applyPersistedSettings(target.settings),
        sessions: state.sessions.map(buildSessionInfo),
        activeId: state.activeId,
    };
}

export function renameSession(id: string, title: string): {
    sessions: SessionInfo[];
    activeId: string;
} {
    const nextTitle = title.trim();
    if (!nextTitle) {
        const state = ensureSessionsState();
        return {
            sessions: state.sessions.map(buildSessionInfo),
            activeId: state.activeId,
        };
    }

    const state = ensureSessionsState();
    updateSession(state, id, (s) => {
        s.title = nextTitle;
        s.updatedAt = Date.now();
    });
    saveSessionsState(state);

    return {
        sessions: state.sessions.map(buildSessionInfo),
        activeId: state.activeId,
    };
}

export function buildSyncPayloads(args: {
    activeSessionId: string;
    activeMessages: ChatMessage[];
    activeSettings: ChatSettings;
}): SessionPayload[] {
    const state = ensureSessionsState();
    return state.sessions.map((s) => {
        if (s.id === args.activeSessionId) {
            return {
                id: s.id,
                title: s.title,
                createdAt: s.createdAt,
                updatedAt: s.updatedAt,
                messages: toPersistedMessages(args.activeMessages),
                settings: toPersistedSettings(args.activeSettings),
            };
        }
        return {
            id: s.id,
            title: s.title,
            createdAt: s.createdAt,
            updatedAt: s.updatedAt,
            messages: s.messages,
            settings: s.settings,
        };
    });
}

export function mergeRemoteSessions(
    sessions: SessionPayload[],
    lastSyncAt: number
): { updated: boolean; overwroteIds: string[] } {
    if (sessions.length === 0) return { updated: false, overwroteIds: [] };
    const state = ensureSessionsState();
    let updated = false;
    const overwroteIds: string[] = [];

    sessions.forEach((remote) => {
        const local = state.sessions.find((s) => s.id === remote.id);
        if (!local) {
            state.sessions.push({
                id: remote.id,
                title: remote.title,
                createdAt: remote.createdAt,
                updatedAt: remote.updatedAt,
                messages: remote.messages,
                settings: remote.settings,
            });
            updated = true;
            return;
        }
        if (remote.updatedAt > local.updatedAt) {
            if (local.updatedAt > lastSyncAt) {
                overwroteIds.push(remote.id);
            }
            local.title = remote.title;
            local.createdAt = remote.createdAt;
            local.updatedAt = remote.updatedAt;
            local.messages = remote.messages;
            local.settings = remote.settings;
            updated = true;
        }
    });

    if (!state.activeId && state.sessions.length > 0) {
        state.activeId = state.sessions[0].id;
        updated = true;
    }

    if (updated) {
        saveSessionsState(state);
    }
    return { updated, overwroteIds };
}

export function loadLastSyncAt(): number {
    const sync = loadSyncState();
    return sync?.lastSyncAt ?? 0;
}

export function updateLastSyncAt(value: number) {
    saveSyncState({ schemaVersion: 1, lastSyncAt: value });
}

export function resetSyncState() {
    clearSyncState();
}
