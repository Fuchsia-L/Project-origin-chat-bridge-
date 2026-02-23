import { useEffect, useMemo, useRef, useState } from "react";
import type { ChatMessage } from "../store/chatStore";

function fmtUsage(u: any) {
    if (!u) return null;
    const input = u.input_tokens ?? u.prompt_tokens ?? 0;
    const output = u.output_tokens ?? u.completion_tokens ?? 0;
    const total = u.total_tokens ?? input + output;
    if (total === 0) return null;
    return `tokens: ${total}`;
}

// best-effort: supports your current gateway format + future variants
function extractThinking(raw: any): string | null {
    try {
        const msg = raw?.choices?.[0]?.message;

        const rc = msg?.reasoning_content;
        if (typeof rc === "string" && rc.trim()) return rc;

        const th = msg?.thinking;
        if (typeof th === "string" && th.trim()) return th;

        // Some providers may return message.content as an array of parts
        const content = msg?.content;
        if (Array.isArray(content)) {
            // Try common shapes: {type:"thinking", text:"..."} or {type:"reasoning", ...}
            for (const part of content) {
                const t = part?.type;
                const text = part?.text ?? part?.content;
                if ((t === "thinking" || t === "reasoning") && typeof text === "string" && text.trim()) {
                    return text;
                }
            }
        }
    } catch {
        // ignore
    }
    return null;
}

function TypewriterText({
    text,
    speed = 18,
    onTick,
}: {
    text: string;
    speed?: number;
    onTick?: () => void;
}) {
    const [visible, setVisible] = useState("");
    const timerRef = useRef<number | null>(null);
    const prevTextRef = useRef<string | null>(null);

    useEffect(() => {
        // 避免每次父组件重渲染都重新打字
        if (prevTextRef.current === text) {
            setVisible(text);
            return;
        }
        prevTextRef.current = text;
        setVisible("");

        const total = text.length;
        let idx = 0;

        const tick = () => {
            idx += 1;
            setVisible(text.slice(0, idx));
            onTick?.();
            if (idx >= total) {
                if (timerRef.current) window.clearInterval(timerRef.current);
                timerRef.current = null;
            }
        };

        // 初始立刻输出第一个字符，随后按间隔
        tick();
        timerRef.current = window.setInterval(tick, speed);

        return () => {
            if (timerRef.current) {
                window.clearInterval(timerRef.current);
                timerRef.current = null;
            }
        };
    }, [text, speed, onTick]);

    return <div>{visible}</div>;
}

function Bubble({
    m,
    onTick,
    typewriter,
    index,
    isEditing,
    editValue,
    onStartEdit,
    onEditValue,
    onSaveEdit,
    onCancelEdit,
    onSendEdit,
    onDelete,
    onRegenerate,
    onStop,
    onSelectVariant,
    isActive,
    onActivate,
    turnNo,
    developerMode,
}: {
    m: ChatMessage;
    onTick: () => void;
    typewriter: boolean;
    index: number;
    isEditing: boolean;
    editValue: string;
    onStartEdit: (index: number, initial: string) => void;
    onEditValue: (value: string) => void;
    onSaveEdit: () => void;
    onCancelEdit: () => void;
    onSendEdit: () => void;
    onDelete: (index: number) => void;
    onRegenerate: (index: number) => void;
    onStop: (streamId: string) => void;
    onSelectVariant: (index: number, variantIndex: number) => void;
    isActive: boolean;
    onActivate: (index: number) => void;
    turnNo: number | null;
    developerMode: boolean;
}) {
    const isUser = m.role === "user";
    const [rawOpen, setRawOpen] = useState(false);
    const [thinkingOpen, setThinkingOpen] = useState(false);
    const [sentOpen, setSentOpen] = useState(false);
    const [memoryOpen, setMemoryOpen] = useState(false);

    const hasRaw = developerMode && m.meta?.raw != null;
    const hasThinking = (m.meta?.thinking ?? "").trim().length > 0;
    const hasMemoryStatus = developerMode && m.meta?.memory_status != null;

    const rawText = useMemo(() => {
        if (!hasRaw) return "";
        try {
            return JSON.stringify(m.meta?.raw, null, 2);
        } catch {
            return String(m.meta?.raw);
        }
    }, [hasRaw, m.meta?.raw]);

    const thinkingText = useMemo(() => {
        if (hasThinking) return m.meta?.thinking ?? "";
        if (!hasRaw) return null;
        return extractThinking(m.meta?.raw);
    }, [hasThinking, hasRaw, m.meta?.raw, m.meta?.thinking]);

    const hasMetaLine = !isUser;
    const statusText = m.meta?.isRetrying
        ? "重试中"
        : m.meta?.isError
        ? "错误"
        : m.meta?.isAborted
        ? "已中断"
        : m.meta?.isStreaming
        ? "生成中"
        : m.meta?.isLoading
        ? "请求中"
        : "完成";
    const connText = m.meta?.request_id ? "已连接" : "未连接";
    const thinkingState = hasThinking ? "有" : "无";
    const totalVariants = m.meta?.variants?.length ?? 0;
    const activeVariantIndex =
        m.meta?.activeVariantIndex ?? (totalVariants > 0 ? totalVariants - 1 : 0);
    const canNavigateVariants = totalVariants > 1 && !m.meta?.isStreaming;

    const shouldTypewriter =
        typewriter &&
        !isUser &&
        !m.meta?.isLoading &&
        !m.meta?.isError &&
        !m.meta?.isStreaming &&
        !((m.meta?.variants?.length ?? 0) > 1);

    return (
        <div
            className={`w-full flex ${isUser ? "justify-end" : "justify-start"} my-2`}
            onClick={(e) => {
                e.stopPropagation();
                onActivate(index);
            }}
        >
            <div
                className={[
                    "max-w-[85%] rounded-2xl px-4 py-2 text-sm leading-relaxed whitespace-pre-wrap break-words group",
                    isUser ? "bg-blue-600 text-white" : "bg-zinc-100 text-zinc-900",
                ].join(" ")}
            >
                {!isUser && (
                    <div className="mb-2 flex items-center gap-3 text-[11px] text-zinc-500">
                        <span>状态: {statusText}</span>
                        <span>连接: {connText}</span>
                        <span>思考: {thinkingState}</span>
                    </div>
                )}

                {!isUser && (
                    <div
                        className={[
                            "mb-2 items-center gap-2 text-[11px] text-zinc-600",
                            isActive ? "flex" : "hidden group-hover:flex",
                        ].join(" ")}
                    >
                        {m.meta?.isStreaming && m.meta?.streamId ? (
                            <button className="underline" onClick={() => onStop(m.meta!.streamId!)}>
                                强制中断
                            </button>
                        ) : null}
                        {!m.meta?.isStreaming ? (
                            <button className="underline" onClick={() => onStartEdit(index, m.content)}>
                                编辑
                            </button>
                        ) : null}
                        <button className="underline" onClick={() => onDelete(index)}>
                            删除
                        </button>
                        {!m.meta?.isStreaming ? (
                            <button className="underline" onClick={() => onRegenerate(index)}>
                                重新生成
                            </button>
                        ) : null}
                        {turnNo ? <span className="text-zinc-500">第{turnNo}轮</span> : null}
                        {canNavigateVariants && (
                            <span className="text-zinc-500">
                                {activeVariantIndex + 1}/{totalVariants}
                            </span>
                        )}
                        {canNavigateVariants && (
                            <button
                                className="underline"
                                onClick={() =>
                                    onSelectVariant(
                                        index,
                                        (activeVariantIndex - 1 + totalVariants) % totalVariants
                                    )
                                }
                                title="上一个版本"
                            >
                                ◀
                            </button>
                        )}
                        {canNavigateVariants && (
                            <button
                                className="underline"
                                onClick={() =>
                                    onSelectVariant(
                                        index,
                                        (activeVariantIndex + 1) % totalVariants
                                    )
                                }
                                title="下一个版本"
                            >
                                ▶
                            </button>
                        )}
                    </div>
                )}

                {isUser && (
                    <div
                        className={[
                            "mb-2 items-center gap-2 text-[11px] text-zinc-200",
                            isActive ? "flex" : "hidden group-hover:flex",
                        ].join(" ")}
                    >
                        {turnNo ? <span className="text-zinc-200">第{turnNo}轮</span> : null}
                        <button className="underline" onClick={() => onStartEdit(index, m.content)}>
                            编辑
                        </button>
                        <button className="underline" onClick={() => onDelete(index)}>
                            删除
                        </button>
                        {developerMode && m.meta?.sent_context?.messages?.length ? (
                            <button className="underline" onClick={() => setSentOpen((v) => !v)}>
                                {sentOpen ? "收起发送原文" : "显示发送原文"}
                            </button>
                        ) : null}
                    </div>
                )}

                {isUser && sentOpen && developerMode && m.meta?.sent_context?.messages?.length ? (
                    <pre className="mb-2 max-h-64 overflow-auto rounded-xl border bg-white p-2 text-[11px] text-zinc-800">
                        {m.meta.sent_context.messages
                            .map((x) => `${x.role}: ${x.content}`)
                            .join("\n\n")}
                    </pre>
                ) : null}

                {!isUser && (thinkingText || hasRaw || hasMemoryStatus) && (
                    <div className="mb-2 flex items-center gap-3 text-[11px] text-zinc-600">
                        {thinkingText && (
                            <button className="underline" onClick={() => setThinkingOpen((v) => !v)}>
                                {thinkingOpen ? "收起 thinking" : "展开 thinking"}
                            </button>
                        )}
                        {hasMemoryStatus && (
                            <button className="underline" onClick={() => setMemoryOpen((v) => !v)}>
                                {memoryOpen ? "收起 memory" : "展开 memory"}
                            </button>
                        )}
                        {hasRaw && (
                            <button className="underline" onClick={() => setRawOpen((v) => !v)}>
                                {rawOpen ? "收起 raw" : "展开 raw"}
                            </button>
                        )}
                    </div>
                )}

                {memoryOpen && hasMemoryStatus && (
                    <pre className="mb-2 max-h-64 overflow-auto rounded-xl border bg-white p-2 text-[11px] text-zinc-800">
                        {JSON.stringify(m.meta?.memory_status, null, 2)}
                    </pre>
                )}

                {thinkingOpen && thinkingText && (
                    <pre className="mb-2 max-h-64 overflow-auto rounded-xl border bg-white p-2 text-[11px] text-zinc-800">
                        {thinkingText}
                    </pre>
                )}

                {rawOpen && hasRaw && (
                    <pre className="mb-2 max-h-64 overflow-auto rounded-xl border bg-white p-2 text-[11px] text-zinc-800">
                        {rawText}
                    </pre>
                )}

                {isEditing ? (
                    <div className="space-y-2">
                        <textarea
                            className="w-full rounded-xl border bg-white p-2 text-sm text-zinc-900 outline-none focus:ring-2 focus:ring-blue-500"
                            rows={4}
                            value={editValue}
                            onChange={(e) => onEditValue(e.target.value)}
                        />
                        {isUser ? (
                            <div className="flex items-center gap-2 text-xs text-zinc-600">
                                <button className="rounded border px-2 py-1" onClick={onSaveEdit}>
                                    保存
                                </button>
                                <button className="rounded border px-2 py-1" onClick={onSendEdit}>
                                    发送
                                </button>
                                <button className="rounded border px-2 py-1" onClick={onCancelEdit}>
                                    x
                                </button>
                            </div>
                        ) : (
                            <div className="flex items-center gap-2 text-xs text-zinc-600">
                                <button className="rounded border px-2 py-1" onClick={onSaveEdit}>
                                    保存
                                </button>
                                <button className="rounded border px-2 py-1" onClick={onCancelEdit}>
                                    取消
                                </button>
                            </div>
                        )}
                    </div>
                ) : shouldTypewriter ? (
                    <TypewriterText text={m.content} onTick={onTick} />
                ) : (
                    <div>{m.content}</div>
                )}

                {/* footer */}
                {!isUser && (hasMetaLine || hasRaw) && (
                    <div className="mt-2 space-y-2">
                        {hasMetaLine && (
                            <div className="text-[11px] text-zinc-500">
                                model: {m.meta?.model ?? "-"}
                                {" · "}
                                {m.meta?.usage ? fmtUsage(m.meta.usage) : "tokens: -"}
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}

export default function ChatWindow({
    messages,
    activePersona,
    onEditMessage,
    onDeleteMessage,
    onRegenerateMessage,
    onStopStream,
    onSelectVariant,
    onSendEditMessage,
    developerMode,
}: {
    messages: ChatMessage[];
    activePersona?: { name: string; avatar_url?: string } | null;
    onEditMessage: (index: number, nextContent: string) => void;
    onDeleteMessage: (index: number) => void;
    onRegenerateMessage: (index: number) => void;
    onStopStream: (streamId: string) => void;
    onSelectVariant: (index: number, variantIndex: number) => void;
    onSendEditMessage: (index: number, nextContent: string) => void;
    developerMode: boolean;
}) {
    const bottomRef = useRef<HTMLDivElement | null>(null);
    const [editingIndex, setEditingIndex] = useState<number | null>(null);
    const [editingValue, setEditingValue] = useState("");
    const [activeIndex, setActiveIndex] = useState<number | null>(null);

    // 仅对最新一条助手回复启用打字机，避免历史消息反复重播
    const lastAssistantIndex = useMemo(() => {
        for (let i = messages.length - 1; i >= 0; i -= 1) {
            const m = messages[i];
            if (m.role === "assistant" && !m.meta?.isError && !m.meta?.isLoading) {
                return i;
            }
        }
        return -1;
    }, [messages]);

    const turnByIndex = useMemo(() => {
        const map: Array<number | null> = [];
        let currentTurn = 0;
        for (let i = 0; i < messages.length; i += 1) {
            if (messages[i].role === "user") {
                currentTurn += 1;
            }
            map[i] = currentTurn > 0 ? currentTurn : null;
        }
        return map;
    }, [messages]);

    useEffect(() => {
        bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [messages.length]);

    return (
        <div
            className="flex-1 overflow-y-auto px-4 py-3"
            onClick={() => setActiveIndex(null)}
        >
            {activePersona ? (
                <div className="mb-3 inline-flex items-center gap-2 rounded-full border bg-white px-3 py-1 text-xs text-zinc-600">
                    {activePersona.avatar_url ? (
                        <img
                            src={activePersona.avatar_url}
                            alt={activePersona.name}
                            className="h-5 w-5 rounded-full object-cover"
                        />
                    ) : (
                        <div className="h-5 w-5 rounded-full bg-zinc-200" />
                    )}
                    <span>当前角色: {activePersona.name}</span>
                </div>
            ) : null}
            {messages.map((m, i) => (
                <Bubble
                    key={i}
                    m={m}
                    typewriter={i === lastAssistantIndex}
                    index={i}
                    isEditing={editingIndex === i}
                    editValue={editingValue}
                    isActive={activeIndex === i}
                    onActivate={(idx) => setActiveIndex(idx)}
                    onStartEdit={(idx, initial) => {
                        setEditingIndex(idx);
                        setEditingValue(initial);
                    }}
                    onEditValue={setEditingValue}
                    onSaveEdit={() => {
                        if (editingIndex === null) return;
                        onEditMessage(editingIndex, editingValue);
                        setEditingIndex(null);
                    }}
                    onSendEdit={() => {
                        if (editingIndex === null) return;
                        onSendEditMessage(editingIndex, editingValue);
                        setEditingIndex(null);
                    }}
                    onCancelEdit={() => setEditingIndex(null)}
                    onDelete={onDeleteMessage}
                    onRegenerate={onRegenerateMessage}
                    onStop={onStopStream}
                    onSelectVariant={onSelectVariant}
                    turnNo={turnByIndex[i] ?? null}
                    developerMode={developerMode}
                    onTick={() => bottomRef.current?.scrollIntoView({ behavior: "smooth" })}
                />
            ))}
            <div ref={bottomRef} />
        </div>
    );
}
