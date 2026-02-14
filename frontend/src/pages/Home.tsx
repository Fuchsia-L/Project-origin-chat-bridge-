// frontend/src/pages/Home.tsx
import { useEffect, useMemo, useRef, useState } from "react";
import { postChat, streamChat } from "../api/chat";
import { logout as apiLogout } from "../api/auth";
import { pullSessions, pushSessions } from "../api/sync";
import ChatWindow from "../components/ChatWindow";
import InputBar from "../components/InputBar";
import SettingsDrawer from "../components/SettingsDrawer";

import type { ChatMessage, ChatSettings, SessionInfo } from "../store/chatStore";
import {
    buildSyncPayloads,
    defaultSettings,
    createSession,
    loadChatState,
    loadLastSyncAt,
    mergeRemoteSessions,
    saveChatState,
    saveSessionStateImmediate,
    clearChatState,
    updateLastSyncAt,
    updateStreamingMessageInSession,
    resetSyncState,
    switchSession,
    renameSession,
} from "../store/chatStore";
import type { AuthState } from "../store/authStore";

const API_BASE = "http://127.0.0.1:8000";

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
    const skipNextPushRef = useRef(false);
    const syncInFlightRef = useRef(false);

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
    }, []);

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
            setConflictNotice("检测到云端版本较新，已覆盖本地未同步内容。");
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

    async function runStream(payload: {
        sessionId: string;
        streamId: string;
        targetIndex?: number;
        request: {
            system_prompt: string;
            model: string;
            temperature: number;
            messages: Array<{ role: "user" | "assistant"; content: string }>;
        };
    }) {
        const controller = new AbortController();
        streamControllersRef.current.set(payload.streamId, controller);

        let acc = "";
        let reqId = "";

        try {
            if (!settingsRef.current.stream) {
                const res = await postChat(API_BASE, payload.request);
                setMessageByStreamId(payload.sessionId, payload.streamId, (m) => {
                    const base = {
                        content: res.reply?.content ?? "",
                        model: settingsRef.current.model,
                        usage: res.usage ?? undefined,
                        thinking: m.meta?.thinking,
                        raw: res.raw ?? undefined,
                    };
                    const prev = m.meta?.variants ?? [];
                    const nextVariants = [...prev, base];
                    return {
                        ...m,
                        content: base.content,
                        meta: {
                            ...m.meta,
                            isStreaming: false,
                            request_id: res.request_id,
                            usage: base.usage,
                            model: base.model,
                            raw: base.raw,
                            variants: nextVariants,
                            activeVariantIndex: nextVariants.length - 1,
                        },
                    };
                });
                return;
            }
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

                    if (event.type === "model") {
                        setMessageByStreamId(payload.sessionId, payload.streamId, (m) => ({
                            ...m,
                            meta: { ...m.meta, model: event.model },
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
                                    const input = u.input_tokens ?? u.prompt_tokens ?? 0;
                                    const output = u.output_tokens ?? u.completion_tokens ?? 0;
                                    const total = u.total_tokens ?? input + output;
                                    const isZero = input === 0 && output === 0 && total === 0;
                                    return isZero && m.meta?.usage ? m.meta.usage : u;
                                })(),
                            },
                        }));
                        return;
                    }

                    if (event.type === "raw") {
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
                        acc += event.content;
                        setMessageByStreamId(payload.sessionId, payload.streamId, (m) => ({
                            ...m,
                            content: (m.content ?? "") + event.content,
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
                        setMessageByStreamId(payload.sessionId, payload.streamId, (m) => {
                            if (!m.meta?.isStreaming) return m;
                            const base = {
                                content: m.content ?? "",
                                model: m.meta?.model,
                                usage: m.meta?.usage,
                                thinking: m.meta?.thinking,
                                raw: m.meta?.raw,
                            };
                            const prev = m.meta?.variants ?? [];
                            const nextVariants = [...prev, base];
                            return {
                                ...m,
                                meta: {
                                    ...m.meta,
                                    isStreaming: false,
                                    variants: nextVariants,
                                    activeVariantIndex: nextVariants.length - 1,
                                },
                            };
                        });
                    }
                },
                { signal: controller.signal }
            );
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
                    isStreaming: false,
                },
            }));
        } finally {
            streamControllersRef.current.delete(payload.streamId);
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
        if (!content || isSending) return;

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
        const nextMessages = [...messagesRef.current, userMsg, streamingMsg];
        setMessages(nextMessages);
        saveSessionStateImmediate({
            sessionId,
            messages: nextMessages,
            settings: settingsRef.current,
        });

        // 组装 payload：历史 + 本次 user（不包含 loading）
        const history = messagesRef.current.filter((m) => !m.meta?.isLoading);

        const payload = {
            system_prompt: settingsRef.current.system_prompt,
            model: settingsRef.current.model,
            temperature: settingsRef.current.temperature,
            messages: [...history, userMsg].map((m) => ({
                role: m.role,
                content: m.content,
            })),
        };

        await runStream({
            sessionId,
            streamId,
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
            system_prompt: settingsRef.current.system_prompt,
            model: settingsRef.current.model,
            temperature: settingsRef.current.temperature,
            messages: history,
        };

        if (activeSessionId) setIsSending(true);
        runStream({
            sessionId: activeSessionId,
            streamId,
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
            system_prompt: settingsRef.current.system_prompt,
            model: settingsRef.current.model,
            temperature: settingsRef.current.temperature,
            messages: history,
        };

        if (activeSessionId) setIsSending(true);
        runStream({
            sessionId: activeSessionId,
            streamId,
            targetIndex: index,
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

    function handleNewSession() {
        const next = createSession();
        setMessages(next.messages);
        setSettings(next.settings);
        setSessions(next.sessions);
        setActiveSessionId(next.activeId);
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

    return (
        <div className="min-h-screen flex flex-col">
            <header className="sticky top-0 z-10 h-12 flex items-center justify-between px-3 border-b bg-white">
                <div className="font-semibold">Project Origin</div>
                <div className="flex items-center gap-2">
                    <div className="text-xs text-gray-500">
                        {props.auth.user.email}
                        {syncStatus === "syncing" ? " · 同步中" : ""}
                        {syncStatus === "error" && syncError ? ` · ${syncError}` : ""}
                    </div>
                    <select
                        className="text-sm rounded border px-2 py-1"
                        value={activeSessionId}
                        onChange={(e) => handleSwitchSession(e.target.value)}
                        disabled={sessions.length === 0}
                        title="切换会话"
                    >
                        {sessions.map((s) => (
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
                        onClick={handleNewSession}
                        title="新建会话"
                    >
                        新会话
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
                        onClick={handleManualSync}
                        disabled={syncStatus === "syncing"}
                        title="立即同步"
                    >
                        立即同步
                    </button>
                    <button
                        className="text-sm px-3 py-1 rounded border hover:bg-gray-50"
                        onClick={handleLogout}
                        title="退出登录"
                    >
                        退出
                    </button>
                    <SettingsDrawer
                        open={settingsOpen}
                        onClose={() => setSettingsOpen(false)}
                        settings={settings}
                        onChange={setSettings}
                    />
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

            <main className="flex-1 overflow-hidden">
                <ChatWindow
                    messages={messages}
                    onEditMessage={handleEditMessage}
                    onDeleteMessage={handleDeleteMessage}
                    onRegenerateMessage={handleRegenerate}
                    onStopStream={stopStream}
                    onSelectVariant={handleSelectVariant}
                    onSendEditMessage={handleSendEditMessage}
                />
            </main>

            <footer className="sticky bottom-0 z-10 border-t bg-white">
                <InputBar disabled={!canSend} onSend={handleSend} />
            </footer>
        </div>
    );
}
