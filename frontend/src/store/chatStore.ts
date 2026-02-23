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
import type { Persona } from "../types/persona";



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
        isRetrying?: boolean;
        retryAttempt?: number;
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
        sent_context?: {
            request_id?: string;
            messages: Array<{ role: string; content: string }>;
        };
        memory_status?: {
            rounds?: number;
            summary?: { enabled: boolean; reason: string };
            memory_extract?: { enabled: boolean; reason: string };
            embedding?: { enabled: boolean; reason: string };
            layered_context?: any;
        };
    };
};

export type ChatSettings = {
    system_prompt: string;
    model: string;
    temperature: number;
    top_p: number;
    frequency_penalty: number;
    presence_penalty: number;
    stream: boolean;
    developer_mode: boolean;
};

export type SessionInfo = {
    id: string;
    title: string;
    createdAt: number;
    updatedAt: number;
    persona_id?: string;
    project_id?: string | null;
};

export type SessionPayload = {
    id: string;
    title: string;
    createdAt: number;
    updatedAt: number;
    deletedAt?: number | null;
    persona_id?: string;
    project_id?: string | null;
    messages: PersistedMessage[];
    settings: PersistedSettings;
};

// ===== 默认值（你之前统一到 Gemini，这里保留） =====
export const defaultSettings: ChatSettings = {
    system_prompt: "",
    model: "gemini-3-pro-preview-11-2025",
    temperature: 0.7,
    top_p: 1,
    frequency_penalty: 0,
    presence_penalty: 0,
    stream: true,
    developer_mode: false,
};

export function toPersistedMessages(messages: ChatMessage[]): PersistedMessage[] {
    const sanitizeMeta = (meta: ChatMessage["meta"]) => {
        if (!meta) return undefined;
        return {
            isAborted: meta.isAborted,
            isError: meta.isError,
            request_id: meta.request_id,
            usage: meta.usage,
            model: meta.model,
            thinking: meta.thinking,
            activeVariantIndex: meta.activeVariantIndex,
            variants: (meta.variants ?? []).map((v) => ({
                content: v.content,
                model: v.model,
                usage: v.usage,
                thinking: v.thinking,
            })),
        };
    };

    // 不保存 loading
    return messages
        .filter((m) => !m.meta?.isLoading)
        .map((m) => ({
            role: m.role,
            content: m.content,
            // 避免 localStorage 超限：不持久化 raw/sent_context/thinking 等大字段
            meta: sanitizeMeta(m.meta),
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
        top_p: s.top_p,
        frequency_penalty: s.frequency_penalty,
        presence_penalty: s.presence_penalty,
        stream: s.stream ?? true,
        developer_mode: s.developer_mode ?? false,
    };
}

export function applyPersistedSettings(s: PersistedSettings): ChatSettings {
    return {
        system_prompt: s.system_prompt ?? defaultSettings.system_prompt,
        model: s.model ?? defaultSettings.model,
        temperature:
            typeof s.temperature === "number" ? s.temperature : defaultSettings.temperature,
        top_p: typeof s.top_p === "number" ? s.top_p : defaultSettings.top_p,
        frequency_penalty:
            typeof s.frequency_penalty === "number"
                ? s.frequency_penalty
                : defaultSettings.frequency_penalty,
        presence_penalty:
            typeof s.presence_penalty === "number"
                ? s.presence_penalty
                : defaultSettings.presence_penalty,
        stream: typeof s.stream === "boolean" ? s.stream : defaultSettings.stream,
        developer_mode:
            typeof s.developer_mode === "boolean"
                ? s.developer_mode
                : defaultSettings.developer_mode,
    };
}

function buildSessionInfo(s: PersistedSession): SessionInfo {
    return {
        id: s.id,
        title: s.title,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        persona_id: s.persona_id,
        project_id: s.project_id ?? null,
    };
}

function isDeletedSession(s: PersistedSession) {
    return typeof s.deletedAt === "number" && s.deletedAt > 0;
}

function listVisibleSessions(state: PersistedSessionsStateV1): PersistedSession[] {
    return state.sessions.filter((s) => !isDeletedSession(s));
}

function ensureSessionsState(): PersistedSessionsStateV1 {
    const existing = loadSessionsState();
    if (existing && existing.sessions.length > 0) {
        const visible = listVisibleSessions(existing);
        if (visible.length === 0) {
            const now = Date.now();
            const id = `s_${now}`;
            existing.sessions.push({
                id,
                title: "会话 1",
                createdAt: now,
                updatedAt: now,
                messages: [],
                settings: toPersistedSettings(defaultSettings),
            });
            existing.activeId = id;
            saveSessionsState(existing);
            return existing;
        }
        if (visible.every((s) => s.id !== existing.activeId)) {
            existing.activeId = visible[0].id;
            saveSessionsState(existing);
        }
        return existing;
    }

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
        state.sessions.find((s) => s.id === state.activeId && !isDeletedSession(s)) ??
        listVisibleSessions(state)[0];
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
        sessions: listVisibleSessions(state).map(buildSessionInfo),
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

export function updateMessageAtInSession(payload: {
    sessionId: string;
    index: number;
    updater: (m: ChatMessage) => ChatMessage;
}) {
    const state = ensureSessionsState();
    updateSession(state, payload.sessionId, (s) => {
        const msgs = fromPersistedMessages(s.messages);
        if (!msgs[payload.index]) return;
        msgs[payload.index] = payload.updater(msgs[payload.index]);
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
        sessions: listVisibleSessions(state).map(buildSessionInfo),
        activeId: state.activeId,
    };
}

export function createSession(persona?: Persona | null, projectId?: string | null): {
    messages: ChatMessage[];
    settings: ChatSettings;
    sessions: SessionInfo[];
    activeId: string;
} {
    const state = ensureSessionsState();
    const now = Date.now();
    const id = `s_${now}`;
    const title = `会话 ${listVisibleSessions(state).length + 1}`;

    const nextSettings = {
        ...defaultSettings,
        system_prompt: persona?.system_prompt ?? defaultSettings.system_prompt,
    };
    const greetingMessages: PersistedMessage[] = persona?.greeting
        ? [{ role: "assistant", content: persona.greeting }]
        : [];

    state.sessions.unshift({
        id,
        title,
        createdAt: now,
        updatedAt: now,
        persona_id: persona?.id,
        project_id: projectId ?? null,
        messages: greetingMessages,
        settings: toPersistedSettings(nextSettings),
    });
    state.activeId = id;
    saveSessionsState(state);

    return {
        messages: fromPersistedMessages(greetingMessages),
        settings: nextSettings,
        sessions: listVisibleSessions(state).map(buildSessionInfo),
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
    const target = state.sessions.find((s) => s.id === id && !isDeletedSession(s));
    if (!target) {
        return loadChatState();
    }

    state.activeId = id;
    saveSessionsState(state);

    return {
        messages: fromPersistedMessages(target.messages),
        settings: applyPersistedSettings(target.settings),
        sessions: listVisibleSessions(state).map(buildSessionInfo),
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
        if (isDeletedSession(s)) return;
        s.title = nextTitle;
        s.updatedAt = Date.now();
    });
    saveSessionsState(state);

    return {
        sessions: listVisibleSessions(state).map(buildSessionInfo),
        activeId: state.activeId,
    };
}

export function reorderSessions(fromId: string, toId: string): {
    sessions: SessionInfo[];
    activeId: string;
} {
    if (fromId === toId) {
        const state = ensureSessionsState();
        return {
            sessions: listVisibleSessions(state).map(buildSessionInfo),
            activeId: state.activeId,
        };
    }
    const state = ensureSessionsState();
    const fromIdx = state.sessions.findIndex((s) => s.id === fromId && !isDeletedSession(s));
    const toIdx = state.sessions.findIndex((s) => s.id === toId && !isDeletedSession(s));
    if (fromIdx === -1 || toIdx === -1) {
        return {
            sessions: listVisibleSessions(state).map(buildSessionInfo),
            activeId: state.activeId,
        };
    }
    const next = [...state.sessions];
    const [moved] = next.splice(fromIdx, 1);
    next.splice(toIdx, 0, moved);
    state.sessions = next;
    saveSessionsState(state);
    return {
        sessions: listVisibleSessions(state).map(buildSessionInfo),
        activeId: state.activeId,
    };
}

export function deleteSession(id: string): {
    messages: ChatMessage[];
    settings: ChatSettings;
    sessions: SessionInfo[];
    activeId: string;
} {
    const state = ensureSessionsState();
    const now = Date.now();
    updateSession(state, id, (s) => {
        s.deletedAt = now;
        s.updatedAt = now;
        s.messages = [];
    });

    const visible = listVisibleSessions(state);
    if (visible.length === 0) {
        const newId = `s_${now}`;
        state.sessions.unshift({
            id: newId,
            title: "会话 1",
            createdAt: now,
            updatedAt: now,
            messages: [],
            settings: toPersistedSettings(defaultSettings),
        });
        state.activeId = newId;
    } else if (state.activeId === id) {
        state.activeId = visible[0].id;
    }
    saveSessionsState(state);

    const active = readActiveSession(state);
    return {
        messages: fromPersistedMessages(active.messages),
        settings: applyPersistedSettings(active.settings),
        sessions: listVisibleSessions(state).map(buildSessionInfo),
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
        const deletedAt = isDeletedSession(s) ? s.deletedAt ?? null : undefined;
        if (s.id === args.activeSessionId) {
            return {
                id: s.id,
                title: s.title,
                createdAt: s.createdAt,
                updatedAt: s.updatedAt,
                deletedAt,
                persona_id: s.persona_id,
                project_id: s.project_id ?? null,
                messages: toPersistedMessages(args.activeMessages),
                settings: toPersistedSettings(args.activeSettings),
            };
        }
        return {
            id: s.id,
            title: s.title,
                createdAt: s.createdAt,
                updatedAt: s.updatedAt,
                deletedAt,
                persona_id: s.persona_id,
                project_id: s.project_id ?? null,
                messages: s.messages,
                settings: s.settings,
            };
    });
}

export function mergeRemoteSessions(
    sessions: SessionPayload[],
    lastSyncAt: number
): { updated: boolean; overwroteIds: string[]; deletedIds: string[] } {
    if (sessions.length === 0) {
        return { updated: false, overwroteIds: [], deletedIds: [] };
    }
    const state = ensureSessionsState();
    let updated = false;
    const overwroteIds: string[] = [];
    const deletedIds: string[] = [];

    sessions.forEach((remote) => {
        const local = state.sessions.find((s) => s.id === remote.id);
        if (remote.deletedAt) {
            if (local && local.updatedAt > remote.updatedAt) {
                return;
            }
            if (local && local.updatedAt > lastSyncAt) {
                overwroteIds.push(remote.id);
            }
            if (local) {
                state.sessions = state.sessions.filter((s) => s.id !== remote.id);
                deletedIds.push(remote.id);
                updated = true;
            }
            return;
        }
        if (!local) {
            state.sessions.push({
                id: remote.id,
                title: remote.title,
                createdAt: remote.createdAt,
                updatedAt: remote.updatedAt,
                deletedAt: remote.deletedAt ?? null,
                persona_id: remote.persona_id,
                project_id: remote.project_id ?? null,
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
            local.deletedAt = remote.deletedAt ?? null;
            local.persona_id = remote.persona_id;
            local.project_id = remote.project_id ?? null;
            local.messages = remote.messages;
            local.settings = remote.settings;
            updated = true;
        }
    });

    if (!state.activeId && state.sessions.length > 0) {
        state.activeId = state.sessions[0].id;
        updated = true;
    }
    const visible = listVisibleSessions(state);
    if (visible.length > 0 && visible.every((s) => s.id !== state.activeId)) {
        state.activeId = visible[0].id;
        updated = true;
    }

    if (updated) {
        saveSessionsState(state);
    }
    return { updated, overwroteIds, deletedIds };
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
