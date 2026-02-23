// frontend/src/pages/Home.tsx
import { useEffect, useMemo, useRef, useState } from "react";
import { postChat, streamChat } from "../api/chat";
import { logout as apiLogout } from "../api/auth";
import { createProject as apiCreateProject, fetchProjects as apiFetchProjects, type Project } from "../api/projects";
import {
    approvePersonaMemory as apiApprovePersonaMemory,
    compressSession as apiCompressSession,
    fetchPersonaMemories as apiFetchPersonaMemories,
    rejectPersonaMemory as apiRejectPersonaMemory,
    updatePersonaMemory as apiUpdatePersonaMemory,
    type PersonaMemory,
} from "../api/memory";
import { pullSessions, pushSessions } from "../api/sync";
import ChatWindow from "../components/ChatWindow";
import InputBar from "../components/InputBar";
import PersonaManagerDrawer from "../components/PersonaManagerDrawer";
import PersonaPickerModal from "../components/PersonaPickerModal";
import ProjectDrawer from "../components/ProjectDrawer";
import SettingsDrawer from "../components/SettingsDrawer";
import type { Persona, PersonaCreate } from "../types/persona";

import type { ChatMessage, ChatSettings, SessionInfo } from "../store/chatStore";
import {
    buildSyncPayloads,
    defaultSettings,
    createSession,
    deleteSession,
    loadChatState,
    loadLastSyncAt,
    mergeRemoteSessions,
    saveChatState,
    saveSessionStateImmediate,
    clearChatState,
    reorderSessions,
    updateLastSyncAt,
    updateStreamingMessageInSession,
    updateMessageAtInSession,
    resetSyncState,
    switchSession,
    renameSession,
} from "../store/chatStore";
import type { AuthState } from "../store/authStore";
import {
    createPersonaAndCache,
    deletePersonaAndCache,
    duplicatePersonaAndCache,
    loadCachedPersonas,
    reorderCachedPersonas,
    syncPersonasFromRemote,
    updatePersonaAndCache,
} from "../store/personaStore";

const API_BASE = "http://127.0.0.1:8000";

function stripRecallPrefix(text: string): string {
    return text.replace(/^\[内部回忆[\s\S]*?回忆结束\]\s*/m, "").trimStart();
}

const EMPTY_REPLY_RETRY_WINDOW_MS = 5000;
const MAX_EMPTY_REPLY_ATTEMPTS = 3;
const SAMPLING_MIN = {
    temperature: 0,
    top_p: 0,
    frequency_penalty: -2,
    presence_penalty: -2,
};

function sleep(ms: number) {
    return new Promise<void>((resolve) => window.setTimeout(resolve, ms));
}

type MemoryReviewDraft = {
    memory_type: string;
    content: string;
    confidence: number;
};

function fmtDateTime(value?: string | null): string {
    if (!value) return "-";
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return value;
    return d.toLocaleString("zh-CN", { hour12: false });
}

export default function Home(props: {
    auth: AuthState;
    onAuthChange: (next: AuthState | null) => void;
}) {
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [settings, setSettings] = useState<ChatSettings>(defaultSettings);
    const [isSending, setIsSending] = useState(false);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [sessions, setSessions] = useState<SessionInfo[]>([]);
    const [activeSessionId, setActiveSessionId] = useState<string>("");
    const [sessionTitleInput, setSessionTitleInput] = useState("");
    const [syncStatus, setSyncStatus] = useState<"idle" | "syncing" | "error">("idle");
    const [syncError, setSyncError] = useState("");
    const [conflictNotice, setConflictNotice] = useState("");
    const [syncNotice, setSyncNotice] = useState("");
    const [isCompressing, setIsCompressing] = useState(false);
    const [memoryReviewOpen, setMemoryReviewOpen] = useState(false);
    const [memoryReviewItems, setMemoryReviewItems] = useState<PersonaMemory[]>([]);
    const [memoryReviewDrafts, setMemoryReviewDrafts] = useState<Record<string, MemoryReviewDraft>>(
        {}
    );
    const [memoryReviewBusyId, setMemoryReviewBusyId] = useState<string | null>(null);
    const [memoryReviewError, setMemoryReviewError] = useState("");
    const [memoryReviewPersonaId, setMemoryReviewPersonaId] = useState<string | null>(null);
    const [personas, setPersonas] = useState<Persona[]>([]);
    const [personaPickerOpen, setPersonaPickerOpen] = useState(false);
    const [personaManagerOpen, setPersonaManagerOpen] = useState(false);
    const [projectDrawerOpen, setProjectDrawerOpen] = useState(false);
    const [projects, setProjects] = useState<Project[]>([]);
    const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
    const [showAllSessions, setShowAllSessions] = useState(false);
    const [draggingSessionId, setDraggingSessionId] = useState<string | null>(null);
    const skipNextPushRef = useRef(false);
    const syncInFlightRef = useRef(false);
    const skippedMemoryIdsRef = useRef<Set<string>>(new Set());

    // 用 ref 保证 save 时拿到最新值（避免闭包旧值）
    const messagesRef = useRef<ChatMessage[]>(messages);
    const settingsRef = useRef<ChatSettings>(settings);

    useEffect(() => {
        messagesRef.current = messages;
    }, [messages]);

    useEffect(() => {
        settingsRef.current = settings;
    }, [settings]);

    // 1) 启动加载
    useEffect(() => {
        const loaded = loadChatState();
        setMessages(loaded.messages);
        setSettings(loaded.settings);
        setSessions(loaded.sessions);
        setActiveSessionId(loaded.activeId);
        setPersonas(loadCachedPersonas());
    }, []);

    useEffect(() => {
        let mounted = true;
        syncPersonasFromRemote(API_BASE, props.auth, (next) => props.onAuthChange(next))
            .then((next) => {
                if (!mounted) return;
                setPersonas(next);
            })
            .catch(() => {
                // ignore; keep local cache
            });
        return () => {
            mounted = false;
        };
    }, [props.auth, props.onAuthChange]);

    async function refreshProjects() {
        const rows = await apiFetchProjects(API_BASE, props.auth, (next) => props.onAuthChange(next));
        setProjects(rows);
    }

    useEffect(() => {
        refreshProjects().catch(() => {
            // keep previous list
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [props.auth.accessToken, props.auth.refreshToken]);

    async function runPullSync(since: number) {
        const remote = await pullSessions(
            API_BASE,
            props.auth,
            (next) => props.onAuthChange(next),
            since
        );
        const mergeResult = mergeRemoteSessions(remote, since);
        if (mergeResult.updated) {
            const loaded = loadChatState();
            setMessages(loaded.messages);
            setSettings(loaded.settings);
            setSessions(loaded.sessions);
            setActiveSessionId(loaded.activeId);
        }
        if (mergeResult.overwroteIds.length > 0) {
            setConflictNotice(
                `云端版本较新，已覆盖本地未同步内容（${mergeResult.overwroteIds.length} 个会话）。`
            );
        }
        if (mergeResult.deletedIds.length > 0) {
            setSyncNotice(
                `检测到云端删除，已移除本地会话（${mergeResult.deletedIds.length} 个）。`
            );
        }
    }

    async function runPushSync() {
        if (!activeSessionId) return;
        saveSessionStateImmediate({
            sessionId: activeSessionId,
            messages,
            settings,
        });
        const payloads = buildSyncPayloads({
            activeSessionId,
            activeMessages: messages,
            activeSettings: settings,
        });
        const result = await pushSessions(
            API_BASE,
            props.auth,
            (next) => props.onAuthChange(next),
            payloads
        );
        if (result.conflicts.length > 0) {
            await runPullSync(0);
            skipNextPushRef.current = true;
            setSyncStatus("error");
            setSyncError("云端版本较新，已拉取覆盖本地");
            updateLastSyncAt(Date.now());
            return;
        }
        updateLastSyncAt(Date.now());
        setSyncNotice(`已同步（${new Date().toLocaleTimeString()}）`);
    }

    async function runFullSync() {
        if (syncInFlightRef.current) return;
        syncInFlightRef.current = true;
        setSyncStatus("syncing");
        setSyncError("");
        try {
            const since = loadLastSyncAt();
            await runPullSync(since);
            await runPushSync();
            setSyncStatus("idle");
        } catch (err: any) {
            setSyncStatus("error");
            setSyncError(err?.message ?? "同步失败");
        } finally {
            syncInFlightRef.current = false;
        }
    }

    useEffect(() => {
        runFullSync();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [props.auth.accessToken, props.auth.refreshToken, props.onAuthChange]);

    useEffect(() => {
        const active = sessions.find((s) => s.id === activeSessionId);
        setSessionTitleInput(active?.title ?? "");
    }, [sessions, activeSessionId]);

    useEffect(() => {
        if (!syncNotice) return;
        const t = window.setTimeout(() => {
            setSyncNotice("");
        }, 3000);
        return () => window.clearTimeout(t);
    }, [syncNotice]);

    // 2) 自动持久化（messages/settings变化就保存）
    useEffect(() => {
        if (!activeSessionId) return;
        saveChatState({ messages, settings, sessionId: activeSessionId });
    }, [messages, settings, activeSessionId]);

    const syncTimerRef = useRef<number | null>(null);

    useEffect(() => {
        if (!activeSessionId) return;
        if (skipNextPushRef.current) {
            skipNextPushRef.current = false;
            return;
        }
        if (syncTimerRef.current) window.clearTimeout(syncTimerRef.current);
        syncTimerRef.current = window.setTimeout(async () => {
            try {
                await runPushSync();
                setSyncStatus("idle");
            } catch (err: any) {
                setSyncStatus("error");
                setSyncError(err?.message ?? "同步失败");
            }
        }, 800);
        return () => {
            if (syncTimerRef.current) window.clearTimeout(syncTimerRef.current);
        };
    }, [
        messages,
        settings,
        sessions,
        activeSessionId,
        props.auth.accessToken,
        props.auth.refreshToken,
        props.onAuthChange,
    ]);

    const canSend = useMemo(() => !isSending, [isSending]);

    const streamControllersRef = useRef<Map<string, AbortController>>(new Map());

    const activeSession = useMemo(
        () => sessions.find((s) => s.id === activeSessionId) ?? null,
        [sessions, activeSessionId]
    );
    const visibleSessions = useMemo(() => {
        if (showAllSessions) return sessions;
        if (selectedProjectId) {
            return sessions.filter((s) => (s.project_id ?? null) === selectedProjectId);
        }
        return sessions.filter((s) => !s.project_id);
    }, [sessions, selectedProjectId, showAllSessions]);
    const currentProject = useMemo(
        () => projects.find((p) => p.id === selectedProjectId) ?? null,
        [projects, selectedProjectId]
    );
    const activeSessionIdForView = useMemo(() => {
        if (visibleSessions.some((s) => s.id === activeSessionId)) return activeSessionId;
        return visibleSessions[0]?.id ?? "";
    }, [visibleSessions, activeSessionId]);
    const activePersona = useMemo(
        () => personas.find((p) => p.id === activeSession?.persona_id) ?? null,
        [personas, activeSession?.persona_id]
    );

    useEffect(() => {
        if (visibleSessions.length === 0) {
            setActiveSessionId("");
            setMessages([]);
            setSettings(defaultSettings);
            return;
        }
        if (visibleSessions.some((s) => s.id === activeSessionId)) return;
        const next = switchSession(visibleSessions[0].id);
        setMessages(next.messages);
        setSettings(next.settings);
        setSessions(next.sessions);
        setActiveSessionId(next.activeId);
    }, [visibleSessions, activeSessionId]);

    function buildSamplingPayload() {
        const temperature =
            settingsRef.current.temperature <= SAMPLING_MIN.temperature
                ? undefined
                : settingsRef.current.temperature;
        let topP =
            settingsRef.current.top_p <= SAMPLING_MIN.top_p
                ? undefined
                : settingsRef.current.top_p;
        const frequencyPenalty =
            settingsRef.current.frequency_penalty <= SAMPLING_MIN.frequency_penalty
                ? undefined
                : settingsRef.current.frequency_penalty;
        const presencePenalty =
            settingsRef.current.presence_penalty <= SAMPLING_MIN.presence_penalty
                ? undefined
                : settingsRef.current.presence_penalty;

        // 部分模型不允许同时传 temperature 和 top_p：默认优先 temperature。
        if (temperature !== undefined && topP !== undefined) {
            topP = undefined;
        }

        return {
            temperature,
            top_p: topP,
            frequency_penalty: frequencyPenalty,
            presence_penalty: presencePenalty,
        };
    }

    function removeMemoryReviewItem(id: string) {
        setMemoryReviewItems((prev) => prev.filter((x) => x.id !== id));
        setMemoryReviewDrafts((prev) => {
            const next = { ...prev };
            delete next[id];
            return next;
        });
    }

    function initMemoryDrafts(items: PersonaMemory[]) {
        const drafts: Record<string, MemoryReviewDraft> = {};
        for (const item of items) {
            drafts[item.id] = {
                memory_type: item.memory_type,
                content: item.content,
                confidence: item.confidence,
            };
        }
        setMemoryReviewDrafts(drafts);
    }

    function closeMemoryReviewIfEmpty() {
        setMemoryReviewItems((prev) => {
            if (prev.length > 0) return prev;
            setMemoryReviewOpen(false);
            setMemoryReviewPersonaId(null);
            return prev;
        });
    }

    async function maybeOpenMemoryReview(personaId?: string | null) {
        if (!personaId) return;
        try {
            const rows = await apiFetchPersonaMemories(
                API_BASE,
                props.auth,
                (next) => props.onAuthChange(next),
                personaId,
                { needs_review: true }
            );
            const skipped = skippedMemoryIdsRef.current;
            const filtered = rows.filter((x) => !skipped.has(x.id));
            if (filtered.length === 0) return;
            setMemoryReviewPersonaId(personaId);
            setMemoryReviewItems(filtered);
            initMemoryDrafts(filtered);
            setMemoryReviewError("");
            setMemoryReviewOpen(true);
        } catch (e: any) {
            setMemoryReviewError(e?.message ?? "加载待审批记忆失败");
        }
    }

    async function handleApproveMemory(item: PersonaMemory) {
        if (!memoryReviewPersonaId) return;
        const draft = memoryReviewDrafts[item.id];
        if (!draft || !draft.content.trim()) return;
        setMemoryReviewBusyId(item.id);
        setMemoryReviewError("");
        try {
            await apiUpdatePersonaMemory(
                API_BASE,
                props.auth,
                (next) => props.onAuthChange(next),
                memoryReviewPersonaId,
                item.id,
                {
                    memory_type: draft.memory_type,
                    content: draft.content.trim(),
                    confidence: Math.max(0, Math.min(1, Number(draft.confidence))),
                }
            );
            await apiApprovePersonaMemory(
                API_BASE,
                props.auth,
                (next) => props.onAuthChange(next),
                memoryReviewPersonaId,
                item.id
            );
            removeMemoryReviewItem(item.id);
            closeMemoryReviewIfEmpty();
        } catch (e: any) {
            setMemoryReviewError(e?.message ?? "审批通过失败");
        } finally {
            setMemoryReviewBusyId(null);
        }
    }

    async function handleRejectMemory(item: PersonaMemory) {
        if (!memoryReviewPersonaId) return;
        setMemoryReviewBusyId(item.id);
        setMemoryReviewError("");
        try {
            await apiRejectPersonaMemory(
                API_BASE,
                props.auth,
                (next) => props.onAuthChange(next),
                memoryReviewPersonaId,
                item.id
            );
            removeMemoryReviewItem(item.id);
            closeMemoryReviewIfEmpty();
        } catch (e: any) {
            setMemoryReviewError(e?.message ?? "审批拒绝失败");
        } finally {
            setMemoryReviewBusyId(null);
        }
    }

    function handleSkipMemory(item: PersonaMemory) {
        skippedMemoryIdsRef.current.add(item.id);
        removeMemoryReviewItem(item.id);
        closeMemoryReviewIfEmpty();
    }

    function resolveSystemPrompt(sessionId: string): string {
        const session = sessions.find((s) => s.id === sessionId);
        if (!session?.persona_id) return settingsRef.current.system_prompt;
        const persona = personas.find((p) => p.id === session.persona_id);
        if (!persona) return settingsRef.current.system_prompt;
        const localPrompt = settingsRef.current.system_prompt;
        if (localPrompt.trim().length > 0 && localPrompt !== persona.system_prompt) {
            return localPrompt;
        }
        return persona.system_prompt;
    }

    function setMessageByStreamId(
        sessionId: string,
        streamId: string,
        updater: (m: ChatMessage) => ChatMessage
    ) {
        if (sessionId !== activeSessionId) {
            updateStreamingMessageInSession({ sessionId, streamId, updater });
            return;
        }
        setMessages((prev) => {
            const next = [...prev];
            const idx = next.findIndex((m) => m.meta?.streamId === streamId);
            if (idx === -1) return prev;
            next[idx] = updater(next[idx]);
            return next;
        });
    }

    function setMessageByIndex(
        sessionId: string,
        index: number,
        updater: (m: ChatMessage) => ChatMessage
    ) {
        if (sessionId !== activeSessionId) {
            updateMessageAtInSession({ sessionId, index, updater });
            return;
        }
        setMessages((prev) => {
            if (!prev[index]) return prev;
            const next = [...prev];
            next[index] = updater(next[index]);
            return next;
        });
    }

    async function runStream(payload: {
        sessionId: string;
        streamId: string;
        targetIndex?: number;
        sourceUserIndex?: number;
        request: {
            system_prompt: string;
            model: string;
            temperature?: number;
            top_p?: number;
            frequency_penalty?: number;
            presence_penalty?: number;
            session_id?: string | null;
            persona_id?: string | null;
            project_id?: string | null;
            messages: Array<{ role: "user" | "assistant"; content: string }>;
        };
    }) {
        let success = false;
        let lastError: any = null;

        try {
            for (let attempt = 1; attempt <= MAX_EMPTY_REPLY_ATTEMPTS; attempt += 1) {
                const controller = new AbortController();
                streamControllersRef.current.set(payload.streamId, controller);
                let reqId = "";
                let hasNonEmptyReply = false;
                let doneReceived = false;
                const attemptStartedAt = Date.now();

                setMessageByStreamId(payload.sessionId, payload.streamId, (m) => ({
                    ...m,
                    content: "",
                    meta: {
                        ...m.meta,
                        isError: false,
                        isAborted: false,
                        isStreaming: settingsRef.current.stream,
                        isRetrying: attempt > 1,
                        retryAttempt: attempt,
                        usage: undefined,
                        raw: undefined,
                        thinking: undefined,
                    },
                }));

                try {
                    if (!settingsRef.current.stream) {
                        const res = await postChat(
                            API_BASE,
                            payload.request,
                            props.auth,
                            (next) => props.onAuthChange(next)
                        );
                        const cleaned = stripRecallPrefix(res.reply?.content ?? "");
                        hasNonEmptyReply = cleaned.trim().length > 0;
                        const elapsed = Date.now() - attemptStartedAt;
                        if (!hasNonEmptyReply && elapsed <= EMPTY_REPLY_RETRY_WINDOW_MS) {
                            if (attempt < MAX_EMPTY_REPLY_ATTEMPTS) {
                                setMessageByStreamId(payload.sessionId, payload.streamId, (m) => ({
                                    ...m,
                                    content: "",
                                    meta: { ...m.meta, isRetrying: true, isStreaming: false },
                                }));
                                const waitMs = Math.max(0, EMPTY_REPLY_RETRY_WINDOW_MS - elapsed);
                                if (waitMs > 0) await sleep(waitMs);
                                continue;
                            }
                            throw new Error("连续收到空回复，重试次数已达上限");
                        }

                        setMessageByStreamId(payload.sessionId, payload.streamId, (m) => {
                            const base = {
                                content: cleaned,
                                model: settingsRef.current.model,
                                usage: res.usage ?? undefined,
                                thinking: m.meta?.thinking,
                                raw: settingsRef.current.developer_mode ? res.raw ?? undefined : undefined,
                            };
                            const prev = m.meta?.variants ?? [];
                            const nextVariants = [...prev, base];
                            return {
                                ...m,
                                content: base.content,
                                meta: {
                                    ...m.meta,
                                    isStreaming: false,
                                    isRetrying: false,
                                    request_id: res.request_id,
                                    usage: base.usage,
                                    model: base.model,
                                    raw: base.raw,
                                    memory_status: settingsRef.current.developer_mode
                                        ? ((res.raw as any)?._memory_status ?? m.meta?.memory_status)
                                        : undefined,
                                    variants: nextVariants,
                                    activeVariantIndex: nextVariants.length - 1,
                                },
                            };
                        });

                        const assembled = (res.raw as any)?._assembled_messages;
                        if (
                            payload.sourceUserIndex !== undefined &&
                            settingsRef.current.developer_mode &&
                            Array.isArray(assembled)
                        ) {
                            setMessageByIndex(payload.sessionId, payload.sourceUserIndex, (m) => ({
                                ...m,
                                meta: {
                                    ...m.meta,
                                    sent_context: {
                                        request_id: res.request_id,
                                        messages: assembled
                                            .filter(
                                                (x: any) =>
                                                    x &&
                                                    typeof x.role === "string" &&
                                                    typeof x.content === "string"
                                            )
                                            .map((x: any) => ({ role: x.role, content: x.content })),
                                    },
                                },
                            }));
                        }
                        success = true;
                        await maybeOpenMemoryReview(payload.request.persona_id);
                        break;
                    }

                    try {
                        await streamChat(
                            API_BASE,
                            payload.request,
                            (event) => {
                                if (event.type === "meta") {
                                    reqId = event.request_id;
                                    setMessageByStreamId(payload.sessionId, payload.streamId, (m) => ({
                                        ...m,
                                        meta: { ...m.meta, request_id: reqId },
                                    }));
                                    return;
                                }

                                if (event.type === "assembled") {
                                    if (
                                        payload.sourceUserIndex !== undefined &&
                                        settingsRef.current.developer_mode &&
                                        Array.isArray(event.messages)
                                    ) {
                                        setMessageByIndex(payload.sessionId, payload.sourceUserIndex, (m) => ({
                                            ...m,
                                            meta: {
                                                ...m.meta,
                                                sent_context: {
                                                    request_id: reqId || m.meta?.request_id,
                                                    messages: event.messages
                                                        .filter(
                                                            (x) =>
                                                                x &&
                                                                typeof x.role === "string" &&
                                                                typeof x.content === "string"
                                                        )
                                                        .map((x) => ({ role: x.role, content: x.content })),
                                                },
                                            },
                                        }));
                                    }
                                    return;
                                }

                                if (event.type === "model") {
                                    setMessageByStreamId(payload.sessionId, payload.streamId, (m) => ({
                                        ...m,
                                        meta: { ...m.meta, model: event.model },
                                    }));
                                    return;
                                }

                                if (event.type === "memory_status") {
                                    if (!settingsRef.current.developer_mode) return;
                                    setMessageByStreamId(payload.sessionId, payload.streamId, (m) => ({
                                        ...m,
                                        meta: { ...m.meta, memory_status: event.status },
                                    }));
                                    return;
                                }

                                if (event.type === "usage") {
                                    setMessageByStreamId(payload.sessionId, payload.streamId, (m) => ({
                                        ...m,
                                        meta: {
                                            ...m.meta,
                                            usage: (() => {
                                                const u = event.usage;
                                                const input = u.input_tokens ?? 0;
                                                const output = u.output_tokens ?? 0;
                                                const total = u.total_tokens ?? input + output;
                                                const isZero = input === 0 && output === 0 && total === 0;
                                                return isZero && m.meta?.usage ? m.meta.usage : u;
                                            })(),
                                        },
                                    }));
                                    return;
                                }

                                if (event.type === "raw") {
                                    if (!settingsRef.current.developer_mode) return;
                                    setMessageByStreamId(payload.sessionId, payload.streamId, (m) => {
                                        const prevRaw = Array.isArray(m.meta?.raw) ? m.meta?.raw : [];
                                        return {
                                            ...m,
                                            meta: { ...m.meta, raw: [...prevRaw, event.raw] },
                                        };
                                    });
                                    return;
                                }

                                if (event.type === "delta") {
                                    const nextChunk = event.content ?? "";
                                    if (nextChunk.trim().length > 0) {
                                        hasNonEmptyReply = true;
                                    }
                                    setMessageByStreamId(payload.sessionId, payload.streamId, (m) => ({
                                        ...m,
                                        content: (m.content ?? "") + nextChunk,
                                        meta: {
                                            ...m.meta,
                                            variants: m.meta?.variants,
                                            activeVariantIndex: m.meta?.activeVariantIndex,
                                        },
                                    }));
                                    return;
                                }

                                if (event.type === "thinking") {
                                    setMessageByStreamId(payload.sessionId, payload.streamId, (m) => ({
                                        ...m,
                                        meta: {
                                            ...m.meta,
                                            thinking: (m.meta?.thinking ?? "") + event.content,
                                        },
                                    }));
                                    return;
                                }

                                if (event.type === "done") {
                                    doneReceived = true;
                                }
                            },
                            { signal: controller.signal },
                            props.auth,
                            (next) => props.onAuthChange(next)
                        );
                    } catch (e: any) {
                        throw e;
                    }

                    const elapsed = Date.now() - attemptStartedAt;
                    if (!hasNonEmptyReply && elapsed <= EMPTY_REPLY_RETRY_WINDOW_MS && doneReceived) {
                        if (attempt < MAX_EMPTY_REPLY_ATTEMPTS) {
                            setMessageByStreamId(payload.sessionId, payload.streamId, (m) => ({
                                ...m,
                                content: "",
                                meta: { ...m.meta, isRetrying: true, isStreaming: false },
                            }));
                            const waitMs = Math.max(0, EMPTY_REPLY_RETRY_WINDOW_MS - elapsed);
                            if (waitMs > 0) await sleep(waitMs);
                            continue;
                        }
                        throw new Error("连续收到空回复，重试次数已达上限");
                    }

                    setMessageByStreamId(payload.sessionId, payload.streamId, (m) => {
                        const cleanedContent = stripRecallPrefix(m.content ?? "");
                        const base = {
                            content: cleanedContent,
                            model: m.meta?.model,
                            usage: m.meta?.usage,
                            thinking: m.meta?.thinking,
                            raw: m.meta?.raw,
                        };
                        const prev = m.meta?.variants ?? [];
                        const nextVariants = [...prev, base];
                        return {
                            ...m,
                            content: cleanedContent,
                            meta: {
                                ...m.meta,
                                isStreaming: false,
                                isRetrying: false,
                                variants: nextVariants,
                                activeVariantIndex: nextVariants.length - 1,
                            },
                        };
                    });
                    success = true;
                    await maybeOpenMemoryReview(payload.request.persona_id);
                    break;
                } catch (attemptError: any) {
                    if (attemptError?.name === "AbortError") {
                        throw attemptError;
                    }
                    lastError = attemptError;
                    if (attempt < MAX_EMPTY_REPLY_ATTEMPTS) {
                        continue;
                    }
                    throw attemptError;
                } finally {
                    streamControllersRef.current.delete(payload.streamId);
                }
            }
        } catch (e: any) {
            if (e?.name === "AbortError") {
                return;
            }
            const errText = e?.message ? `请求失败：${e.message}` : "请求失败：未知错误";
            setMessageByStreamId(payload.sessionId, payload.streamId, (m) => ({
                ...m,
                content: errText,
                meta: {
                    ...m.meta,
                    isError: true,
                    isRetrying: false,
                    isStreaming: false,
                },
            }));
        } finally {
            if (!success && lastError) {
                // keep lastError captured for debugging in message meta.raw if needed
            }
            if (payload.sessionId === activeSessionId) {
                setIsSending(false);
            }
        }
    }

    function stopStream(streamId: string) {
        const ctl = streamControllersRef.current.get(streamId);
        if (ctl) ctl.abort();
        setMessageByStreamId(activeSessionId, streamId, (m) => ({
            ...m,
            meta: { ...m.meta, isStreaming: false, isAborted: true },
        }));
    }

    async function handleSend(text: string) {
        const content = text.trim();
        if (!content || isSending || !activeSessionId) return;
        skippedMemoryIdsRef.current.clear();

        setIsSending(true);
        const sessionId = activeSessionId;

        const userMsg: ChatMessage = { role: "user", content };
        const streamId = `stream_${Date.now()}`;
        const streamingMsg: ChatMessage = {
            role: "assistant",
            content: "",
            meta: {
                isStreaming: settingsRef.current.stream,
                streamId,
                model: settingsRef.current.model,
                variants: [],
            },
        };

        // 先本地插入 user + loading
        const baseMessages = messagesRef.current.map((m) =>
            m.meta?.sent_context ? { ...m, meta: { ...m.meta, sent_context: undefined } } : m
        );
        const userIndex = baseMessages.length;
        const nextMessages = [...baseMessages, userMsg, streamingMsg];
        setMessages(nextMessages);
        saveSessionStateImmediate({
            sessionId,
            messages: nextMessages,
            settings: settingsRef.current,
        });

        // 组装 payload：历史 + 本次 user（不包含 loading）
        const history = messagesRef.current.filter((m) => !m.meta?.isLoading);

        const payload = {
            system_prompt: resolveSystemPrompt(sessionId),
            model: settingsRef.current.model,
            ...buildSamplingPayload(),
            session_id: sessionId,
            persona_id: activeSession?.persona_id ?? null,
            project_id: activeSession?.project_id ?? null,
            messages: [...history, userMsg].map((m) => ({
                role: m.role,
                content: m.content,
            })),
        };

        await runStream({
            sessionId,
            streamId,
            sourceUserIndex: userIndex,
            request: payload,
        });
    }

    function handleDeleteMessage(index: number) {
        setMessages((prev) => {
            if (!prev[index]) return prev;
            const target = prev[index];
            if (target.meta?.streamId) {
                stopStream(target.meta.streamId);
            }
            const next = [...prev];
            const variants = target.meta?.variants ?? [];
            if (target.role === "assistant" && variants.length > 0) {
                const activeIdx =
                    target.meta?.activeVariantIndex ?? Math.max(0, variants.length - 1);
                const newVariants = variants.filter((_, i) => i !== activeIdx);
                if (newVariants.length === 0) {
                    next.splice(index, 1);
                } else {
                    const nextActiveIdx = Math.min(activeIdx, newVariants.length - 1);
                    const v = newVariants[nextActiveIdx];
                    next[index] = {
                        ...target,
                        content: v.content,
                        meta: {
                            ...target.meta,
                            model: v.model,
                            usage: v.usage,
                            thinking: v.thinking,
                            raw: v.raw,
                            variants: newVariants,
                            activeVariantIndex: nextActiveIdx,
                        },
                    };
                }
            } else {
                next.splice(index, 1);
            }
            saveSessionStateImmediate({
                sessionId: activeSessionId,
                messages: next,
                settings: settingsRef.current,
            });
            return next;
        });
    }

    function handleEditMessage(index: number, nextContent: string) {
        setMessages((prev) => {
            if (!prev[index]) return prev;
            const next = [...prev];
            next[index] = { ...next[index], content: nextContent };
            saveSessionStateImmediate({
                sessionId: activeSessionId,
                messages: next,
                settings: settingsRef.current,
            });
            return next;
        });
    }

    function handleSendEditMessage(index: number, nextContent: string) {
        const next = [...messagesRef.current];
        if (!next[index]) return;
        next[index] = { ...next[index], content: nextContent };
        saveSessionStateImmediate({
            sessionId: activeSessionId,
            messages: next,
            settings: settingsRef.current,
        });
        setMessages(next);

        const nextAssistantIdx = (() => {
            for (let i = index + 1; i < next.length; i += 1) {
                if (next[i].role === "assistant") return i;
            }
            return -1;
        })();
        if (nextAssistantIdx !== -1) {
            regenerateWithMessages(nextAssistantIdx, next);
            return;
        }

        const streamId = `stream_${Date.now()}`;
        const streamingMsg: ChatMessage = {
            role: "assistant",
            content: "",
            meta: {
                isStreaming: settingsRef.current.stream,
                streamId,
                model: settingsRef.current.model,
                variants: [],
            },
        };
        const insertAt = index + 1;
        const withAssistant = [...next];
        withAssistant.splice(insertAt, 0, streamingMsg);
        saveSessionStateImmediate({
            sessionId: activeSessionId,
            messages: withAssistant,
            settings: settingsRef.current,
        });
        setMessages(withAssistant);

        const history = withAssistant
            .slice(0, insertAt)
            .filter((m) => !m.meta?.isLoading)
            .map((m) => ({ role: m.role, content: m.content }));

        const request = {
            system_prompt: resolveSystemPrompt(activeSessionId),
            model: settingsRef.current.model,
            ...buildSamplingPayload(),
            session_id: activeSessionId,
            persona_id: activeSession?.persona_id ?? null,
            project_id: activeSession?.project_id ?? null,
            messages: history,
        };

        if (activeSessionId) setIsSending(true);
        const userIndex = (() => {
            for (let i = insertAt - 1; i >= 0; i -= 1) {
                if (withAssistant[i].role === "user") return i;
            }
            return undefined;
        })();
        runStream({
            sessionId: activeSessionId,
            streamId,
            sourceUserIndex: userIndex,
            request,
        });
    }

    function regenerateWithMessages(index: number, baseMessages: ChatMessage[]) {
        if (!baseMessages[index] || baseMessages[index].role !== "assistant") return;
        const userIdx = (() => {
            for (let i = index - 1; i >= 0; i -= 1) {
                if (baseMessages[i].role === "user") return i;
            }
            return -1;
        })();
        if (userIdx === -1) return;

        const streamId = `stream_${Date.now()}`;
        setMessages((prev) => {
            const next = [...prev];
            const prevVariants = next[index].meta?.variants ?? [];
            next[index] = {
                role: "assistant",
                content: "",
                meta: {
                    isStreaming: true,
                    streamId,
                    model: settingsRef.current.model,
                    variants: prevVariants,
                    activeVariantIndex: prevVariants.length,
                },
            };
            return next;
        });

        const history = baseMessages
            .slice(0, userIdx + 1)
            .filter((m) => !m.meta?.isLoading)
            .map((m) => ({ role: m.role, content: m.content }));

        const request = {
            system_prompt: resolveSystemPrompt(activeSessionId),
            model: settingsRef.current.model,
            ...buildSamplingPayload(),
            session_id: activeSessionId,
            persona_id: activeSession?.persona_id ?? null,
            project_id: activeSession?.project_id ?? null,
            messages: history,
        };

        if (activeSessionId) setIsSending(true);
        const sourceUserIndex = userIdx >= 0 ? userIdx : undefined;
        runStream({
            sessionId: activeSessionId,
            streamId,
            targetIndex: index,
            sourceUserIndex,
            request,
        });
    }

    function handleRegenerate(index: number) {
        regenerateWithMessages(index, messagesRef.current);
    }

    function handleSelectVariant(index: number, variantIndex: number) {
        setMessages((prev) => {
            if (!prev[index]) return prev;
            const m = prev[index];
            const variants = m.meta?.variants ?? [];
            const v = variants[variantIndex];
            if (!v) return prev;
            const next = [...prev];
            next[index] = {
                ...m,
                content: v.content,
                meta: {
                    ...m.meta,
                    model: v.model,
                    usage: v.usage,
                    thinking: v.thinking,
                    raw: v.raw,
                    activeVariantIndex: variantIndex,
                },
            };
            saveSessionStateImmediate({
                sessionId: activeSessionId,
                messages: next,
                settings: settingsRef.current,
            });
            return next;
        });
    }

    function handleClear() {
        const cleared = clearChatState();
        setMessages(cleared.messages);
        setSettings(cleared.settings);
        setSessions(cleared.sessions);
        setActiveSessionId(cleared.activeId);
    }

    function handleNewSession(persona: Persona | null = null) {
        const projectIdForNew = showAllSessions ? null : selectedProjectId;
        const next = createSession(persona, projectIdForNew);
        setMessages(next.messages);
        setSettings(next.settings);
        setSessions(next.sessions);
        setActiveSessionId(next.activeId);
        setPersonaPickerOpen(false);
    }

    async function handleCreatePersona(payload: PersonaCreate) {
        const next = await createPersonaAndCache(
            API_BASE,
            props.auth,
            (updated) => props.onAuthChange(updated),
            payload
        );
        setPersonas(next);
    }

    async function handleUpdatePersona(id: string, payload: Partial<Persona>) {
        const next = await updatePersonaAndCache(
            API_BASE,
            props.auth,
            (updated) => props.onAuthChange(updated),
            id,
            payload
        );
        setPersonas(next);
    }

    async function handleDeletePersona(id: string) {
        const next = await deletePersonaAndCache(
            API_BASE,
            props.auth,
            (updated) => props.onAuthChange(updated),
            id
        );
        setPersonas(next);
    }

    async function handleDuplicatePersona(id: string) {
        const next = await duplicatePersonaAndCache(
            API_BASE,
            props.auth,
            (updated) => props.onAuthChange(updated),
            id
        );
        setPersonas(next);
    }

    function handleReorderPersona(fromId: string, toId: string) {
        const next = reorderCachedPersonas(fromId, toId);
        setPersonas(next);
    }

    function handleDeleteSession() {
        if (!activeSessionId) return;
        const ok = window.confirm("确定要删除当前会话吗？删除后将同步到云端，且不可恢复。");
        if (!ok) return;
        const next = deleteSession(activeSessionId);
        setMessages(next.messages);
        setSettings(next.settings);
        setSessions(next.sessions);
        setActiveSessionId(next.activeId);
        setSyncNotice("已删除当前会话，等待同步。");
    }

    function handleSwitchSession(id: string) {
        if (id === activeSessionId) return;
        if (activeSessionId) {
            saveSessionStateImmediate({
                sessionId: activeSessionId,
                messages,
                settings,
            });
        }
        const next = switchSession(id);
        setMessages(next.messages);
        setSettings(next.settings);
        setSessions(next.sessions);
        setActiveSessionId(next.activeId);
    }

    function handleReorderSession(fromId: string, toId: string) {
        const next = reorderSessions(fromId, toId);
        setSessions(next.sessions);
        setActiveSessionId(next.activeId);
    }

    function handleRenameSession() {
        if (!activeSessionId) return;
        const next = renameSession(activeSessionId, sessionTitleInput);
        setSessions(next.sessions);
        setActiveSessionId(next.activeId);
    }

    async function handleLogout() {
        try {
            await apiLogout(API_BASE, props.auth.refreshToken);
        } catch {
            // ignore logout errors
        } finally {
            resetSyncState();
            props.onAuthChange(null);
        }
    }

    async function handleManualSync() {
        await runFullSync();
    }

    async function handleGlobalCompress() {
        if (!activeSessionId || isCompressing) return;
        setIsCompressing(true);
        try {
            const res = await apiCompressSession(
                API_BASE,
                props.auth,
                (next) => props.onAuthChange(next),
                activeSessionId
            );
            setSyncNotice(`已全局压缩：${res.token_count} tokens`);
        } catch (e: any) {
            setSyncError(e?.message ?? "全局压缩失败");
            setSyncStatus("error");
        } finally {
            setIsCompressing(false);
        }
    }

    function handleSelectProject(projectId: string) {
        setShowAllSessions(false);
        setSelectedProjectId(projectId);
    }

    function handleSelectAllSessions() {
        setShowAllSessions(true);
        setSelectedProjectId(null);
    }

    function handleExitProject() {
        setShowAllSessions(false);
        setSelectedProjectId(null);
    }

    async function handleCreateProject(input: {
        name: string;
        description?: string;
        memoryIsolation: boolean;
    }) {
        await apiCreateProject(API_BASE, props.auth, (next) => props.onAuthChange(next), {
            name: input.name,
            context_doc: {
                description: input.description ?? "",
                memory_isolation: input.memoryIsolation,
            },
        });
        await refreshProjects();
    }

    return (
        <div className="min-h-screen flex flex-col">
            <header className="sticky top-0 z-10 h-12 flex items-center justify-between px-3 border-b bg-white">
                <div className="flex items-center gap-2">
                    <div className="font-semibold">Project Origin</div>
                    {currentProject ? (
                        <span className="rounded border border-blue-200 bg-blue-50 px-2 py-0.5 text-xs text-blue-700">
                            当前项目：{currentProject.name}
                        </span>
                    ) : showAllSessions ? (
                        <span className="rounded border px-2 py-0.5 text-xs text-zinc-600">全部会话</span>
                    ) : (
                        <span className="rounded border px-2 py-0.5 text-xs text-zinc-600">无项目</span>
                    )}
                </div>
                <div className="flex items-center gap-2">
                    <div className="text-xs text-gray-500">
                        {props.auth.user.email}
                        {syncStatus === "syncing" ? " · 同步中" : ""}
                        {syncStatus === "error" && syncError ? ` · ${syncError}` : ""}
                    </div>
                    <select
                        className="text-sm rounded border px-2 py-1"
                        value={activeSessionIdForView}
                        onChange={(e) => handleSwitchSession(e.target.value)}
                        disabled={visibleSessions.length === 0}
                        title="切换会话"
                    >
                        {visibleSessions.map((s) => (
                            <option key={s.id} value={s.id}>
                                {s.title}
                            </option>
                        ))}
                    </select>
                    <input
                        className="text-sm rounded border px-2 py-1 w-40"
                        value={sessionTitleInput}
                        onChange={(e) => setSessionTitleInput(e.target.value)}
                        onBlur={handleRenameSession}
                        onKeyDown={(e) => {
                            if (e.key === "Enter") {
                                e.preventDefault();
                                handleRenameSession();
                            }
                        }}
                        placeholder="会话名称"
                        title="编辑当前会话名称"
                    />
                    <button
                        className="text-sm px-3 py-1 rounded border hover:bg-gray-50"
                        onClick={() => setProjectDrawerOpen(true)}
                        title="项目管理"
                    >
                        项目
                    </button>
                    <button
                        className="text-sm px-3 py-1 rounded border hover:bg-gray-50"
                        onClick={() => handleNewSession(null)}
                        title="新建会话"
                    >
                        新会话
                    </button>
                    <button
                        className="text-sm px-3 py-1 rounded border hover:bg-gray-50"
                        onClick={() => setPersonaPickerOpen(true)}
                        title="选择角色创建会话"
                    >
                        选角色
                    </button>
                    <button
                        className="text-sm px-3 py-1 rounded border hover:bg-gray-50"
                        onClick={() => setPersonaManagerOpen(true)}
                        title="角色管理"
                    >
                        角色
                    </button>
                    <button
                        className="text-sm px-3 py-1 rounded border hover:bg-gray-50"
                        onClick={() => setSettingsOpen(true)}
                        disabled={isSending}
                        title="打开设置"
                    >
                        设置
                    </button>
                    <button
                        className="text-sm px-3 py-1 rounded border hover:bg-gray-50"
                        onClick={handleClear}
                        disabled={isSending}
                        title="清空当前会话（并清空本地保存）"
                    >
                        清空会话
                    </button>
                    <button
                        className="text-sm px-3 py-1 rounded border hover:bg-gray-50"
                        onClick={handleDeleteSession}
                        disabled={isSending || visibleSessions.length === 0}
                        title="删除当前会话（会同步到云端）"
                    >
                        删除会话
                    </button>
                    <button
                        className="text-sm px-3 py-1 rounded border hover:bg-gray-50"
                        onClick={handleManualSync}
                        disabled={syncStatus === "syncing"}
                        title="立即同步"
                    >
                        立即同步
                    </button>
                    <button
                        className="text-sm px-3 py-1 rounded border hover:bg-gray-50"
                        onClick={handleGlobalCompress}
                        disabled={isCompressing || !activeSessionId}
                        title="用当前会话全部上下文执行一次全局摘要压缩"
                    >
                        {isCompressing ? "压缩中..." : "全局压缩"}
                    </button>
                    <button
                        className="text-sm px-3 py-1 rounded border hover:bg-gray-50"
                        onClick={handleLogout}
                        title="退出登录"
                    >
                        退出
                    </button>
                </div>
            </header>
            {conflictNotice ? (
                <div className="px-3 py-2 text-sm bg-yellow-50 border-b border-yellow-200 text-yellow-900 flex items-center justify-between">
                    <span>{conflictNotice}</span>
                    <button
                        className="text-xs px-2 py-1 rounded border border-yellow-300 hover:bg-yellow-100"
                        onClick={() => setConflictNotice("")}
                    >
                        知道了
                    </button>
                </div>
            ) : null}
            {syncNotice ? (
                <div className="px-3 py-2 text-sm bg-blue-50 border-b border-blue-200 text-blue-900 flex items-center justify-between">
                    <span>{syncNotice}</span>
                    <button
                        className="text-xs px-2 py-1 rounded border border-blue-300 hover:bg-blue-100"
                        onClick={() => setSyncNotice("")}
                    >
                        知道了
                    </button>
                </div>
            ) : null}
            <div className="sticky top-12 z-10 border-b bg-white px-3 py-2">
                <div className="flex items-center gap-2 overflow-x-auto">
                    {visibleSessions.map((s) => (
                        <button
                            key={s.id}
                            className={[
                                "shrink-0 rounded-lg border px-3 py-1 text-xs",
                                s.id === activeSessionId
                                    ? "border-blue-600 bg-blue-50 text-blue-700"
                                    : "hover:bg-zinc-50",
                                draggingSessionId === s.id ? "opacity-70" : "",
                            ].join(" ")}
                            draggable
                            onDragStart={() => setDraggingSessionId(s.id)}
                            onDragEnd={() => setDraggingSessionId(null)}
                            onDragOver={(e) => e.preventDefault()}
                            onDrop={(e) => {
                                e.preventDefault();
                                if (!draggingSessionId || draggingSessionId === s.id) return;
                                handleReorderSession(draggingSessionId, s.id);
                                setDraggingSessionId(null);
                            }}
                            onClick={() => handleSwitchSession(s.id)}
                            title="拖拽可排序，点击可切换会话"
                        >
                            {s.title}
                        </button>
                    ))}
                </div>
            </div>

            <main className="flex-1 overflow-hidden">
                <ChatWindow
                    messages={messages}
                    developerMode={settings.developer_mode}
                    activePersona={
                        activePersona
                            ? {
                                  name: activePersona.name,
                                  avatar_url: activePersona.avatar_url,
                              }
                            : null
                    }
                    onEditMessage={handleEditMessage}
                    onDeleteMessage={handleDeleteMessage}
                    onRegenerateMessage={handleRegenerate}
                    onStopStream={stopStream}
                    onSelectVariant={handleSelectVariant}
                    onSendEditMessage={handleSendEditMessage}
                />
            </main>

            <footer className="sticky bottom-0 z-10 border-t bg-white">
                <InputBar disabled={!canSend || !activeSessionId} onSend={handleSend} />
            </footer>
            <SettingsDrawer
                open={settingsOpen}
                onClose={() => setSettingsOpen(false)}
                settings={settings}
                onChange={setSettings}
            />
            <ProjectDrawer
                open={projectDrawerOpen}
                onClose={() => setProjectDrawerOpen(false)}
                projects={projects}
                sessions={sessions}
                selectedProjectId={selectedProjectId}
                showAllSessions={showAllSessions}
                onSelectProject={handleSelectProject}
                onSelectAllSessions={handleSelectAllSessions}
                onExitProject={handleExitProject}
                onSwitchSession={handleSwitchSession}
                onCreateProject={handleCreateProject}
            />
            <PersonaManagerDrawer
                open={personaManagerOpen}
                model={settings.model}
                personas={personas}
                auth={props.auth}
                onAuthChange={props.onAuthChange}
                onClose={() => setPersonaManagerOpen(false)}
                onCreate={handleCreatePersona}
                onUpdate={handleUpdatePersona}
                onDelete={handleDeletePersona}
                onDuplicate={handleDuplicatePersona}
                onReorder={handleReorderPersona}
            />
            <PersonaPickerModal
                open={personaPickerOpen}
                personas={personas}
                onClose={() => setPersonaPickerOpen(false)}
                onPick={handleNewSession}
            />
            {memoryReviewOpen ? (
                <div className="fixed inset-0 z-[70]">
                    <div
                        className="absolute inset-0 bg-black/35"
                        onClick={() => setMemoryReviewOpen(false)}
                    />
                    <div className="absolute left-1/2 top-1/2 w-[96%] max-w-3xl -translate-x-1/2 -translate-y-1/2 rounded-2xl border bg-white shadow-2xl">
                        <div className="flex items-center justify-between border-b px-4 py-3">
                            <div className="font-medium">长期记忆写入审批</div>
                            <button
                                className="text-sm text-zinc-600"
                                onClick={() => setMemoryReviewOpen(false)}
                            >
                                关闭
                            </button>
                        </div>
                        <div className="max-h-[70vh] space-y-3 overflow-y-auto p-4">
                            {memoryReviewError ? (
                                <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                                    {memoryReviewError}
                                </div>
                            ) : null}
                            {memoryReviewItems.length === 0 ? (
                                <div className="text-sm text-zinc-500">当前没有待审批记忆。</div>
                            ) : (
                                memoryReviewItems.map((item) => {
                                    const draft = memoryReviewDrafts[item.id] ?? {
                                        memory_type: item.memory_type,
                                        content: item.content,
                                        confidence: item.confidence,
                                    };
                                    const busy = memoryReviewBusyId === item.id;
                                    return (
                                        <div key={item.id} className="rounded-xl border p-3">
                                            <div className="grid gap-2 md:grid-cols-[180px_1fr]">
                                                <select
                                                    className="rounded border px-2 py-1 text-sm"
                                                    value={draft.memory_type}
                                                    onChange={(e) =>
                                                        setMemoryReviewDrafts((prev) => ({
                                                            ...prev,
                                                            [item.id]: {
                                                                ...draft,
                                                                memory_type: e.target.value,
                                                            },
                                                        }))
                                                    }
                                                    disabled={busy}
                                                >
                                                    {[
                                                        "identity",
                                                        "preference",
                                                        "fact",
                                                        "correction",
                                                        "relationship",
                                                        "commitment",
                                                        "status",
                                                    ].map((t) => (
                                                        <option key={t} value={t}>
                                                            {t}
                                                        </option>
                                                    ))}
                                                </select>
                                                <input
                                                    className="rounded border px-2 py-1 text-sm"
                                                    type="number"
                                                    min={0}
                                                    max={1}
                                                    step={0.01}
                                                    value={draft.confidence}
                                                    onChange={(e) =>
                                                        setMemoryReviewDrafts((prev) => ({
                                                            ...prev,
                                                            [item.id]: {
                                                                ...draft,
                                                                confidence: Number(e.target.value),
                                                            },
                                                        }))
                                                    }
                                                    disabled={busy}
                                                />
                                            </div>
                                            <textarea
                                                className="mt-2 w-full rounded border p-2 text-sm"
                                                rows={3}
                                                value={draft.content}
                                                onChange={(e) =>
                                                    setMemoryReviewDrafts((prev) => ({
                                                        ...prev,
                                                        [item.id]: { ...draft, content: e.target.value },
                                                    }))
                                                }
                                                disabled={busy}
                                            />
                                            <div className="mt-1 text-[11px] text-zinc-500">
                                                写入: {fmtDateTime(item.created_at)} · 更新:{" "}
                                                {fmtDateTime(item.updated_at)}
                                            </div>
                                            {item.review_hints && item.review_hints.length > 0 ? (
                                                <div className="mt-2 rounded border border-amber-200 bg-amber-50 px-2 py-1 text-xs text-amber-800">
                                                    {item.review_hints.map((h, idx) => (
                                                        <div key={`${item.id}_hint_${idx}`}>{h}</div>
                                                    ))}
                                                </div>
                                            ) : null}
                                            <div className="mt-2 flex items-center gap-2 text-xs">
                                                <button
                                                    className="rounded border px-2 py-1 hover:bg-zinc-50 disabled:opacity-50"
                                                    onClick={() => handleApproveMemory(item)}
                                                    disabled={busy || !draft.content.trim()}
                                                >
                                                    {busy ? "处理中..." : "确认写入"}
                                                </button>
                                                <button
                                                    className="rounded border px-2 py-1 hover:bg-zinc-50 disabled:opacity-50"
                                                    onClick={() => handleRejectMemory(item)}
                                                    disabled={busy}
                                                >
                                                    拒绝
                                                </button>
                                                <button
                                                    className="rounded border px-2 py-1 hover:bg-zinc-50 disabled:opacity-50"
                                                    onClick={() => handleSkipMemory(item)}
                                                    disabled={busy}
                                                >
                                                    跳过
                                                </button>
                                            </div>
                                        </div>
                                    );
                                })
                            )}
                        </div>
                    </div>
                </div>
            ) : null}
        </div>
    );
}
