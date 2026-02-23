import { useEffect, useMemo, useState } from "react";
import type { Persona, PersonaCreate } from "../types/persona";
import { postChat } from "../api/chat";
import type { AuthState } from "../store/authStore";
import {
    deletePersonaMemory,
    fetchPersonaMemories,
    updatePersonaMemory,
    type PersonaMemory,
} from "../api/memory";

const API_BASE = "http://127.0.0.1:8000";
const MEMORY_TYPE_OPTIONS = [
    "identity",
    "preference",
    "fact",
    "correction",
    "relationship",
    "commitment",
    "status",
];

type MemoryDraft = {
    memory_type: string;
    content: string;
    confidence: number;
    is_active: boolean;
    needs_review: boolean;
};

function fmtMemoryTime(value?: string | null): string {
    if (!value) return "-";
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return value;
    return d.toLocaleString("zh-CN", { hour12: false });
}

type PersonaForm = {
    name: string;
    description: string;
    system_prompt: string;
    greeting: string;
    tags: string;
    avatar_url: string;
    is_default: boolean;
};

const EMPTY_FORM: PersonaForm = {
    name: "",
    description: "",
    system_prompt: "",
    greeting: "",
    tags: "",
    avatar_url: "",
    is_default: false,
};

function toForm(persona: Persona): PersonaForm {
    return {
        name: persona.name,
        description: persona.description ?? "",
        system_prompt: persona.system_prompt,
        greeting: persona.greeting ?? "",
        tags: (persona.tags ?? []).join(", "),
        avatar_url: persona.avatar_url ?? "",
        is_default: Boolean(persona.is_default),
    };
}

function toPayload(form: PersonaForm): PersonaCreate {
    return {
        name: form.name.trim(),
        description: form.description.trim() || undefined,
        system_prompt: form.system_prompt.trim(),
        greeting: form.greeting.trim() || undefined,
        tags: form.tags
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean),
        avatar_url: form.avatar_url.trim() || undefined,
        is_default: form.is_default,
        example_messages: [],
    };
}

export default function PersonaManagerDrawer({
    open,
    model,
    personas,
    auth,
    onAuthChange,
    onClose,
    onCreate,
    onUpdate,
    onDelete,
    onDuplicate,
    onReorder,
}: {
    open: boolean;
    model: string;
    personas: Persona[];
    auth: AuthState;
    onAuthChange: (next: AuthState | null) => void;
    onClose: () => void;
    onCreate: (payload: PersonaCreate) => Promise<void>;
    onUpdate: (id: string, payload: Partial<Persona>) => Promise<void>;
    onDelete: (id: string) => Promise<void>;
    onDuplicate: (id: string) => Promise<void>;
    onReorder: (fromId: string, toId: string) => void;
}) {
    const [activeId, setActiveId] = useState<string>("");
    const [form, setForm] = useState<PersonaForm>(EMPTY_FORM);
    const [error, setError] = useState("");
    const [saving, setSaving] = useState(false);
    const [promptGenerating, setPromptGenerating] = useState(false);
    const [promptError, setPromptError] = useState<string | null>(null);
    const [draggingId, setDraggingId] = useState<string | null>(null);
    const [memoriesOpen, setMemoriesOpen] = useState(false);
    const [memories, setMemories] = useState<PersonaMemory[]>([]);
    const [memoriesLoading, setMemoriesLoading] = useState(false);
    const [memoriesError, setMemoriesError] = useState<string | null>(null);
    const [editingMemoryId, setEditingMemoryId] = useState<string | null>(null);
    const [memoryDraft, setMemoryDraft] = useState<MemoryDraft | null>(null);
    const [memorySavingId, setMemorySavingId] = useState<string | null>(null);
    const [memoryDeletingId, setMemoryDeletingId] = useState<string | null>(null);

    const activePersona = useMemo(() => {
        if (!activeId) return null;
        return personas.find((p) => p.id === activeId) ?? null;
    }, [activeId, personas]);

    function resetMemoryPanel() {
        setMemoriesOpen(false);
        setMemories([]);
        setMemoriesLoading(false);
        setMemoriesError(null);
        setEditingMemoryId(null);
        setMemoryDraft(null);
        setMemorySavingId(null);
        setMemoryDeletingId(null);
    }

    function openCreateForm() {
        setActiveId("");
        setForm(EMPTY_FORM);
        setError("");
        setPromptError(null);
        resetMemoryPanel();
    }

    function openEditForm(persona: Persona) {
        setActiveId(persona.id);
        setForm(toForm(persona));
        setError("");
        setPromptError(null);
        resetMemoryPanel();
    }

    useEffect(() => {
        if (!error) return;
        if (form.name.trim() && form.system_prompt.trim()) {
            setError("");
        }
    }, [error, form.name, form.system_prompt]);

    async function handleAutoPrompt() {
        const seed = form.system_prompt.trim();
        if (!seed || !model) {
            setPromptError("请先输入少量 System Prompt，并确保选择了模型。");
            return;
        }
        setPromptError(null);
        setPromptGenerating(true);
        try {
            const res = await postChat(API_BASE, {
                system_prompt:
                    "你是提示词工程师。请基于用户给出的简要 System Prompt，扩写成完整、可直接使用的系统提示词。只输出最终 System Prompt，不要解释。",
                model,
                temperature: 0.2,
                messages: [
                    {
                        role: "user",
                        content: `简要 System Prompt：\n${seed}\n\n请扩写为完整 System Prompt：`,
                    },
                ],
            });
            const next = res.reply?.content?.trim();
            if (next) {
                setForm((prev) => ({ ...prev, system_prompt: next }));
            } else {
                setPromptError("模型未返回内容，请重试。");
            }
        } catch (e: any) {
            setPromptError(e?.message ?? "生成失败，请重试。");
        } finally {
            setPromptGenerating(false);
        }
    }

    async function handleSubmit() {
        const payload = toPayload(form);
        if (!payload.name || !payload.system_prompt) {
            setError("角色名和 system prompt 为必填项");
            return;
        }
        setSaving(true);
        setError("");
        try {
            if (activePersona) {
                await onUpdate(activePersona.id, payload);
            } else {
                await onCreate(payload);
            }
            openCreateForm();
        } catch (e: any) {
            setError(e?.message ?? "保存失败");
        } finally {
            setSaving(false);
        }
    }

    async function handleDelete(id: string) {
        if (!window.confirm("确定删除该角色吗？该操作不可恢复。")) return;
        await onDelete(id);
        if (activeId === id) {
            openCreateForm();
        }
    }

    async function loadMemories(personaId: string) {
        setMemoriesLoading(true);
        setMemoriesError(null);
        try {
            const rows = await fetchPersonaMemories(API_BASE, auth, onAuthChange, personaId);
            setMemories(rows);
        } catch (e: any) {
            setMemoriesError(e?.message ?? "加载角色记忆失败");
        } finally {
            setMemoriesLoading(false);
        }
    }

    async function toggleMemories() {
        if (!activePersona) return;
        if (memoriesOpen) {
            setMemoriesOpen(false);
            setEditingMemoryId(null);
            setMemoryDraft(null);
            return;
        }
        setMemoriesOpen(true);
        await loadMemories(activePersona.id);
    }

    function beginEditMemory(item: PersonaMemory) {
        setEditingMemoryId(item.id);
        setMemoryDraft({
            memory_type: item.memory_type,
            content: item.content,
            confidence: Number.isFinite(item.confidence) ? item.confidence : 1,
            is_active: item.is_active,
            needs_review: item.needs_review,
        });
    }

    function cancelEditMemory() {
        setEditingMemoryId(null);
        setMemoryDraft(null);
    }

    async function saveMemory(item: PersonaMemory) {
        if (!activePersona || !memoryDraft) return;
        setMemorySavingId(item.id);
        setMemoriesError(null);
        try {
            const updated = await updatePersonaMemory(
                API_BASE,
                auth,
                onAuthChange,
                activePersona.id,
                item.id,
                {
                    memory_type: memoryDraft.memory_type,
                    content: memoryDraft.content.trim(),
                    confidence: Math.max(0, Math.min(1, Number(memoryDraft.confidence))),
                    is_active: memoryDraft.is_active,
                    needs_review: memoryDraft.needs_review,
                }
            );
            setMemories((prev) => prev.map((m) => (m.id === updated.id ? updated : m)));
            cancelEditMemory();
        } catch (e: any) {
            setMemoriesError(e?.message ?? "保存记忆失败");
        } finally {
            setMemorySavingId(null);
        }
    }

    async function removeMemory(item: PersonaMemory) {
        if (!activePersona) return;
        if (!window.confirm("确定删除这条记忆吗？该操作不可恢复。")) return;
        setMemoryDeletingId(item.id);
        setMemoriesError(null);
        try {
            await deletePersonaMemory(API_BASE, auth, onAuthChange, activePersona.id, item.id);
            setMemories((prev) => prev.filter((m) => m.id !== item.id));
            if (editingMemoryId === item.id) {
                cancelEditMemory();
            }
        } catch (e: any) {
            setMemoriesError(e?.message ?? "删除记忆失败");
        } finally {
            setMemoryDeletingId(null);
        }
    }

    if (!open) return null;

    return (
        <div className="fixed inset-0 z-50">
            <div className="absolute inset-0 bg-black/30" onClick={onClose} />
            <div className="absolute right-0 top-0 h-full w-[96%] max-w-5xl bg-white shadow-xl">
                <div className="flex items-center justify-between border-b p-4">
                    <div className="font-medium">角色管理</div>
                    <button className="text-sm text-zinc-600" onClick={onClose}>
                        关闭
                    </button>
                </div>

                <div className="grid h-[calc(100%-57px)] grid-cols-1 gap-4 p-4 md:grid-cols-[340px_1fr]">
                    <div className="space-y-3 overflow-y-auto pr-1">
                        <button
                            className="w-full rounded-xl border px-3 py-2 text-sm hover:bg-gray-50"
                            onClick={openCreateForm}
                        >
                            + 新建角色
                        </button>
                        {personas.length === 0 ? (
                            <div className="rounded-xl border border-dashed px-3 py-6 text-center text-sm text-zinc-500">
                                暂无角色
                            </div>
                        ) : (
                            personas.map((p) => (
                                <div
                                    key={p.id}
                                    className={[
                                        "rounded-xl border p-3",
                                        activeId === p.id ? "border-blue-500 bg-blue-50" : "bg-white",
                                        draggingId === p.id ? "opacity-70" : "",
                                    ].join(" ")}
                                    draggable
                                    onDragStart={() => setDraggingId(p.id)}
                                    onDragEnd={() => setDraggingId(null)}
                                    onDragOver={(e) => e.preventDefault()}
                                    onDrop={(e) => {
                                        e.preventDefault();
                                        if (!draggingId || draggingId === p.id) return;
                                        onReorder(draggingId, p.id);
                                        setDraggingId(null);
                                    }}
                                >
                                    <button className="w-full text-left" onClick={() => openEditForm(p)}>
                                        <div className="flex items-center gap-2">
                                            {p.avatar_url ? (
                                                <img
                                                    src={p.avatar_url}
                                                    alt={p.name}
                                                    className="h-8 w-8 rounded-full object-cover"
                                                />
                                            ) : (
                                                <div className="h-8 w-8 rounded-full bg-zinc-200" />
                                            )}
                                            <div className="min-w-0">
                                                <div className="truncate text-sm font-medium">{p.name}</div>
                                                {p.description ? (
                                                    <div className="truncate text-xs text-zinc-500">
                                                        {p.description}
                                                    </div>
                                                ) : null}
                                            </div>
                                        </div>
                                        {(p.tags ?? []).length > 0 ? (
                                            <div className="mt-2 flex flex-wrap gap-1">
                                                {(p.tags ?? []).slice(0, 4).map((tag) => (
                                                    <span
                                                        key={tag}
                                                        className="rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] text-zinc-600"
                                                    >
                                                        #{tag}
                                                    </span>
                                                ))}
                                            </div>
                                        ) : null}
                                    </button>
                                    <div className="mt-2 flex items-center gap-2 text-xs">
                                        <button
                                            className="rounded border px-2 py-1 hover:bg-zinc-50"
                                            onClick={() => onDuplicate(p.id)}
                                        >
                                            复制
                                        </button>
                                        <button
                                            className="rounded border px-2 py-1 text-red-600 hover:bg-red-50"
                                            onClick={() => handleDelete(p.id)}
                                        >
                                            删除
                                        </button>
                                        {p.is_default ? (
                                            <span className="text-blue-600">默认</span>
                                        ) : null}
                                    </div>
                                </div>
                            ))
                        )}
                    </div>

                    <div className="space-y-3 overflow-y-auto pr-1">
                        <div className="flex items-center justify-between">
                            <div className="text-sm font-medium">
                                {activePersona ? "编辑角色" : "新建角色"}
                            </div>
                            {activePersona ? (
                                <button
                                    className="rounded-xl border px-3 py-2 text-xs hover:bg-gray-50"
                                    onClick={toggleMemories}
                                >
                                    {memoriesOpen ? "隐藏角色记忆" : "角色记忆"}
                                </button>
                            ) : null}
                        </div>
                        {memoriesOpen ? (
                            <div className="rounded-xl border bg-zinc-50 p-3">
                                <div className="mb-2 text-xs text-zinc-600">
                                    角色全局记忆（跨会话）
                                </div>
                                {memoriesError ? (
                                    <div className="mb-2 rounded border border-red-200 bg-red-50 px-2 py-1 text-xs text-red-700">
                                        {memoriesError}
                                    </div>
                                ) : null}
                                {memoriesLoading ? (
                                    <div className="text-xs text-zinc-500">加载中...</div>
                                ) : memories.length === 0 ? (
                                    <div className="text-xs text-zinc-500">暂无记忆</div>
                                ) : (
                                    <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
                                        {memories.map((m) => {
                                            const editing = editingMemoryId === m.id;
                                            return (
                                                <div key={m.id} className="rounded border bg-white p-2">
                                                    {editing && memoryDraft ? (
                                                        <div className="space-y-2">
                                                            <select
                                                                className="w-full rounded border px-2 py-1 text-xs"
                                                                value={memoryDraft.memory_type}
                                                                onChange={(e) =>
                                                                    setMemoryDraft({
                                                                        ...memoryDraft,
                                                                        memory_type: e.target.value,
                                                                    })
                                                                }
                                                            >
                                                                {MEMORY_TYPE_OPTIONS.map((type) => (
                                                                    <option key={type} value={type}>
                                                                        {type}
                                                                    </option>
                                                                ))}
                                                            </select>
                                                            <textarea
                                                                className="w-full rounded border p-2 text-xs"
                                                                rows={3}
                                                                value={memoryDraft.content}
                                                                onChange={(e) =>
                                                                    setMemoryDraft({
                                                                        ...memoryDraft,
                                                                        content: e.target.value,
                                                                    })
                                                                }
                                                            />
                                                            <div className="grid grid-cols-2 gap-2">
                                                                <input
                                                                    className="rounded border px-2 py-1 text-xs"
                                                                    type="number"
                                                                    min={0}
                                                                    max={1}
                                                                    step={0.01}
                                                                    value={memoryDraft.confidence}
                                                                    onChange={(e) =>
                                                                        setMemoryDraft({
                                                                            ...memoryDraft,
                                                                            confidence: Number(
                                                                                e.target.value
                                                                            ),
                                                                        })
                                                                    }
                                                                />
                                                                <label className="inline-flex items-center gap-1 text-xs">
                                                                    <input
                                                                        type="checkbox"
                                                                        checked={memoryDraft.is_active}
                                                                        onChange={(e) =>
                                                                            setMemoryDraft({
                                                                                ...memoryDraft,
                                                                                is_active:
                                                                                    e.target.checked,
                                                                            })
                                                                        }
                                                                    />
                                                                    激活
                                                                </label>
                                                                <label className="inline-flex items-center gap-1 text-xs">
                                                                    <input
                                                                        type="checkbox"
                                                                        checked={memoryDraft.needs_review}
                                                                        onChange={(e) =>
                                                                            setMemoryDraft({
                                                                                ...memoryDraft,
                                                                                needs_review:
                                                                                    e.target.checked,
                                                                            })
                                                                        }
                                                                    />
                                                                    待审核
                                                                </label>
                                                            </div>
                                                            <div className="flex items-center gap-2 text-xs">
                                                                <button
                                                                    className="rounded border px-2 py-1 hover:bg-zinc-50 disabled:opacity-50"
                                                                    onClick={() => saveMemory(m)}
                                                                    disabled={
                                                                        memorySavingId === m.id ||
                                                                        !memoryDraft.content.trim()
                                                                    }
                                                                >
                                                                    {memorySavingId === m.id
                                                                        ? "保存中..."
                                                                        : "保存"}
                                                                </button>
                                                                <button
                                                                    className="rounded border px-2 py-1 hover:bg-zinc-50"
                                                                    onClick={cancelEditMemory}
                                                                >
                                                                    取消
                                                                </button>
                                                            </div>
                                                        </div>
                                                    ) : (
                                                        <>
                                                            <div className="text-xs text-zinc-800">
                                                                {m.content}
                                                            </div>
                                                            <div className="mt-1 flex flex-wrap items-center gap-1 text-[11px] text-zinc-500">
                                                                <span className="rounded bg-zinc-100 px-1.5 py-0.5">
                                                                    {m.memory_type}
                                                                </span>
                                                                <span className="rounded bg-zinc-100 px-1.5 py-0.5">
                                                                    conf {m.confidence.toFixed(2)}
                                                                </span>
                                                                <span className="rounded bg-zinc-100 px-1.5 py-0.5">
                                                                    {m.is_active ? "active" : "inactive"}
                                                                </span>
                                                                {m.needs_review ? (
                                                                    <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-700">
                                                                        needs_review
                                                                    </span>
                                                                ) : null}
                                                            </div>
                                                            <div className="mt-1 text-[11px] text-zinc-500">
                                                                写入: {fmtMemoryTime(m.created_at)} · 更新:{" "}
                                                                {fmtMemoryTime(m.updated_at)}
                                                            </div>
                                                            <div className="mt-2 flex items-center gap-2 text-xs">
                                                                <button
                                                                    className="rounded border px-2 py-1 hover:bg-zinc-50"
                                                                    onClick={() => beginEditMemory(m)}
                                                                >
                                                                    编辑
                                                                </button>
                                                                <button
                                                                    className="rounded border px-2 py-1 text-red-600 hover:bg-red-50 disabled:opacity-50"
                                                                    onClick={() => removeMemory(m)}
                                                                    disabled={memoryDeletingId === m.id}
                                                                >
                                                                    {memoryDeletingId === m.id
                                                                        ? "删除中..."
                                                                        : "删除"}
                                                                </button>
                                                            </div>
                                                        </>
                                                    )}
                                                </div>
                                            );
                                        })}
                                    </div>
                                )}
                            </div>
                        ) : null}
                        <input
                            className="w-full rounded-xl border px-3 py-2 text-sm"
                            placeholder="角色名"
                            value={form.name}
                            onChange={(e) => setForm({ ...form, name: e.target.value })}
                        />
                        <textarea
                            className="w-full rounded-xl border p-3 text-sm"
                            rows={3}
                            placeholder="角色简介（用于卡片展示）"
                            value={form.description}
                            onChange={(e) => setForm({ ...form, description: e.target.value })}
                        />
                        <textarea
                            className="w-full rounded-xl border p-3 text-sm"
                            rows={7}
                            placeholder="System Prompt"
                            value={form.system_prompt}
                            onChange={(e) => setForm({ ...form, system_prompt: e.target.value })}
                        />
                        <div className="flex items-center gap-2">
                            <button
                                className="rounded-xl border px-3 py-2 text-sm hover:bg-gray-50 disabled:opacity-50"
                                onClick={handleAutoPrompt}
                                disabled={promptGenerating}
                                title="使用当前模型扩写角色 System Prompt"
                            >
                                {promptGenerating ? "生成中..." : "自动完善"}
                            </button>
                            {promptError ? (
                                <div className="text-xs text-red-600">{promptError}</div>
                            ) : null}
                        </div>
                        <textarea
                            className="w-full rounded-xl border p-3 text-sm"
                            rows={3}
                            placeholder="Greeting（可选）"
                            value={form.greeting}
                            onChange={(e) => setForm({ ...form, greeting: e.target.value })}
                        />
                        <input
                            className="w-full rounded-xl border px-3 py-2 text-sm"
                            placeholder="标签（逗号分隔）"
                            value={form.tags}
                            onChange={(e) => setForm({ ...form, tags: e.target.value })}
                        />
                        <input
                            className="w-full rounded-xl border px-3 py-2 text-sm"
                            placeholder="头像 URL"
                            value={form.avatar_url}
                            onChange={(e) => setForm({ ...form, avatar_url: e.target.value })}
                        />
                        <label className="inline-flex items-center gap-2 text-sm">
                            <input
                                type="checkbox"
                                checked={form.is_default}
                                onChange={(e) => setForm({ ...form, is_default: e.target.checked })}
                            />
                            设为默认角色
                        </label>
                        {error ? <div className="text-sm text-red-600">{error}</div> : null}
                        <div className="flex items-center gap-2">
                            <button
                                className="rounded-xl border px-3 py-2 text-sm hover:bg-gray-50 disabled:opacity-50"
                                onClick={handleSubmit}
                                disabled={saving}
                            >
                                {saving ? "保存中..." : activePersona ? "保存修改" : "创建角色"}
                            </button>
                            {activePersona ? (
                                <button
                                    className="rounded-xl border px-3 py-2 text-sm hover:bg-gray-50"
                                    onClick={openCreateForm}
                                >
                                    取消编辑
                                </button>
                            ) : null}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
