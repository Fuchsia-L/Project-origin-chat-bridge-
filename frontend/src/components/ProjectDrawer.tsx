import { useMemo, useState } from "react";
import type { SessionInfo } from "../store/chatStore";
import type { Project } from "../api/projects";

export default function ProjectDrawer({
    open,
    onClose,
    projects,
    sessions,
    selectedProjectId,
    showAllSessions,
    onSelectProject,
    onSelectAllSessions,
    onExitProject,
    onSwitchSession,
    onCreateProject,
}: {
    open: boolean;
    onClose: () => void;
    projects: Project[];
    sessions: SessionInfo[];
    selectedProjectId: string | null;
    showAllSessions: boolean;
    onSelectProject: (projectId: string) => void;
    onSelectAllSessions: () => void;
    onExitProject: () => void;
    onSwitchSession: (sessionId: string) => void;
    onCreateProject: (input: {
        name: string;
        description?: string;
        memoryIsolation: boolean;
    }) => Promise<void>;
}) {
    const [expanded, setExpanded] = useState<Record<string, boolean>>({});
    const [creating, setCreating] = useState(false);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");
    const [name, setName] = useState("");
    const [description, setDescription] = useState("");
    const [memoryIsolation, setMemoryIsolation] = useState(true);

    const sessionMap = useMemo(() => {
        const map: Record<string, SessionInfo[]> = {};
        for (const s of sessions) {
            const key = s.project_id ?? "__none__";
            map[key] = map[key] ?? [];
            map[key].push(s);
        }
        return map;
    }, [sessions]);

    async function handleCreate() {
        if (!name.trim() || saving) return;
        setSaving(true);
        setError("");
        try {
            await onCreateProject({
                name: name.trim(),
                description: description.trim() || undefined,
                memoryIsolation,
            });
            setCreating(false);
            setName("");
            setDescription("");
            setMemoryIsolation(true);
        } catch (e: any) {
            setError(e?.message ?? "创建项目失败");
        } finally {
            setSaving(false);
        }
    }

    if (!open) return null;

    return (
        <div className="fixed inset-0 z-50">
            <div className="absolute inset-0 bg-black/30" onClick={onClose} />
            <div className="absolute right-0 top-0 h-full w-[92%] max-w-md bg-white shadow-xl">
                <div className="flex items-center justify-between border-b p-4">
                    <div className="font-medium">项目管理</div>
                    <button className="text-sm text-zinc-600" onClick={onClose}>
                        关闭
                    </button>
                </div>

                <div className="h-[calc(100%-64px)] overflow-y-auto p-4 space-y-4">
                    <div className="flex gap-2">
                        <button
                            className={[
                                "rounded border px-2 py-1 text-xs",
                                showAllSessions ? "bg-blue-50 border-blue-600 text-blue-700" : "hover:bg-zinc-50",
                            ].join(" ")}
                            onClick={onSelectAllSessions}
                        >
                            全部会话
                        </button>
                        <button
                            className={[
                                "rounded border px-2 py-1 text-xs",
                                !showAllSessions && !selectedProjectId
                                    ? "bg-blue-50 border-blue-600 text-blue-700"
                                    : "hover:bg-zinc-50",
                            ].join(" ")}
                            onClick={onExitProject}
                        >
                            退出项目
                        </button>
                    </div>

                    <div className="space-y-2">
                        {projects.length === 0 ? (
                            <div className="text-sm text-zinc-500">暂无项目</div>
                        ) : (
                            projects.map((p) => {
                                const list = sessionMap[p.id] ?? [];
                                const desc = String(p.context_doc?.description ?? "").trim();
                                const isExpanded = !!expanded[p.id];
                                return (
                                    <div key={p.id} className="rounded-xl border p-3">
                                        <div className="flex items-start justify-between gap-2">
                                            <button
                                                className="text-left"
                                                onClick={() => onSelectProject(p.id)}
                                                title="选择该项目"
                                            >
                                                <div className="text-sm font-medium">
                                                    {p.name}
                                                    {selectedProjectId === p.id && !showAllSessions ? (
                                                        <span className="ml-1 text-xs text-blue-600">当前</span>
                                                    ) : null}
                                                </div>
                                                <div className="text-xs text-zinc-500">
                                                    {desc || "无描述"} · {list.length} 个会话
                                                </div>
                                            </button>
                                            <button
                                                className="text-xs text-zinc-600 hover:text-zinc-900"
                                                onClick={() =>
                                                    setExpanded((prev) => ({ ...prev, [p.id]: !prev[p.id] }))
                                                }
                                            >
                                                {isExpanded ? "收起" : "展开"}
                                            </button>
                                        </div>
                                        {isExpanded ? (
                                            <div className="mt-2 space-y-1 border-t pt-2">
                                                {list.length === 0 ? (
                                                    <div className="text-xs text-zinc-500">暂无会话</div>
                                                ) : (
                                                    list.map((s) => (
                                                        <button
                                                            key={s.id}
                                                            className="block w-full rounded border px-2 py-1 text-left text-xs hover:bg-zinc-50"
                                                            onClick={() => onSwitchSession(s.id)}
                                                        >
                                                            {s.title}
                                                        </button>
                                                    ))
                                                )}
                                            </div>
                                        ) : null}
                                    </div>
                                );
                            })
                        )}
                    </div>

                    {!creating ? (
                        <button
                            className="w-full rounded border px-3 py-2 text-sm hover:bg-zinc-50"
                            onClick={() => setCreating(true)}
                        >
                            新建项目
                        </button>
                    ) : (
                        <div className="rounded-xl border p-3 space-y-2">
                            <div className="text-sm font-medium">新建项目</div>
                            <input
                                className="w-full rounded border px-2 py-1 text-sm"
                                placeholder="项目名称（必填）"
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                            />
                            <textarea
                                className="w-full rounded border p-2 text-sm"
                                rows={3}
                                placeholder="项目描述（选填）"
                                value={description}
                                onChange={(e) => setDescription(e.target.value)}
                            />
                            <div className="flex items-center justify-between rounded border px-2 py-1">
                                <span className="text-sm">记忆隔离</span>
                                <button
                                    className={[
                                        "rounded-full px-3 py-1 text-xs",
                                        memoryIsolation ? "bg-blue-600 text-white" : "bg-zinc-100 text-zinc-700",
                                    ].join(" ")}
                                    onClick={() => setMemoryIsolation((v) => !v)}
                                >
                                    {memoryIsolation ? "开启" : "关闭"}
                                </button>
                            </div>
                            {error ? <div className="text-xs text-red-600">{error}</div> : null}
                            <div className="flex justify-end gap-2">
                                <button
                                    className="rounded border px-3 py-1 text-sm hover:bg-zinc-50"
                                    onClick={() => setCreating(false)}
                                    disabled={saving}
                                >
                                    取消
                                </button>
                                <button
                                    className="rounded border px-3 py-1 text-sm hover:bg-zinc-50 disabled:opacity-50"
                                    onClick={handleCreate}
                                    disabled={saving || !name.trim()}
                                >
                                    {saving ? "创建中..." : "提交"}
                                </button>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
