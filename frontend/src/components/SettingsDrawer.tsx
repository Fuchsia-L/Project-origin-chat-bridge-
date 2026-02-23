import { useEffect, useMemo, useState } from "react";
import type { ChatSettings } from "../store/chatStore";
import { loadModelList, saveModelList } from "../store/persist";
import { postChat } from "../api/chat";

const DEFAULT_MODELS = [
    "gpt-4o-mini",
    "gpt-4o",
    "gemini-3-pro-preview-11-2025",
];

const API_BASE = "http://127.0.0.1:8000";

const DEFAULT_SAMPLING_PARAMS = {
    temperature: 0.7,
    top_p: 1,
    frequency_penalty: 0,
    presence_penalty: 0,
};

const PARAM_MIN = {
    temperature: 0,
    top_p: 0,
    frequency_penalty: -2,
    presence_penalty: -2,
};

function fmtParam(value: number, min: number, digits = 2) {
    if (value <= min) return "未设置";
    return value.toFixed(digits);
}

export default function SettingsDrawer({
    open,
    onClose,
    settings,
    onChange,
}: {
    open: boolean;
    onClose: () => void;
    settings: ChatSettings;
    onChange: (next: ChatSettings) => void;
}) {
    const [models, setModels] = useState<string[]>([]);
    const [newModel, setNewModel] = useState("");
    const [dragging, setDragging] = useState<string | null>(null);
    const [promptGenerating, setPromptGenerating] = useState(false);
    const [promptError, setPromptError] = useState<string | null>(null);

    useEffect(() => {
        const stored = loadModelList();
        const initial = stored && stored.length > 0 ? stored : DEFAULT_MODELS;
        setModels(initial);
        if (!stored) saveModelList(initial);
    }, []);

    useEffect(() => {
        if (settings.model && !models.includes(settings.model)) {
            setModels([settings.model, ...models]);
        }
    }, [settings.model, models]);

    useEffect(() => {
        if (models.length > 0) saveModelList(models);
    }, [models]);

    const modelOptions = useMemo(() => {
        if (models.includes(settings.model) || !settings.model) return models;
        return [settings.model, ...models];
    }, [models, settings.model]);

    function addModel() {
        const name = newModel.trim();
        if (!name) return;
        if (!models.includes(name)) {
            setModels([name, ...models]);
        }
        onChange({ ...settings, model: name });
        setNewModel("");
    }

    function deleteModel(name: string) {
        if (models.length <= 1) return;
        const next = models.filter((m) => m !== name);
        setModels(next);
        if (settings.model === name) {
            onChange({ ...settings, model: next[0] ?? "" });
        }
    }

    function moveModel(from: string, to: string) {
        if (from === to) return;
        const fromIdx = models.indexOf(from);
        const toIdx = models.indexOf(to);
        if (fromIdx === -1 || toIdx === -1) return;
        const next = [...models];
        next.splice(fromIdx, 1);
        next.splice(toIdx, 0, from);
        setModels(next);
    }

    async function handleAutoPrompt() {
        const seed = settings.system_prompt.trim();
        if (!seed || !settings.model) {
            setPromptError("请先输入少量 System Prompt，并确保选择了模型。");
            return;
        }

        setPromptError(null);
        setPromptGenerating(true);
        try {
            const res = await postChat(API_BASE, {
                system_prompt:
                    "你是提示词工程师。请基于用户给出的简要 System Prompt，扩写成完整、可直接使用的系统提示词。只输出最终 System Prompt，不要解释。",
                model: settings.model,
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
                onChange({ ...settings, system_prompt: next });
            } else {
                setPromptError("模型未返回内容，请重试。");
            }
        } catch (e: any) {
            setPromptError(e?.message ?? "生成失败，请重试。");
        } finally {
            setPromptGenerating(false);
        }
    }

    if (!open) return null;

    return (
        <div className="fixed inset-0 z-50">
            <div className="absolute inset-0 bg-black/30" onClick={onClose} />
            <div className="absolute right-0 top-0 h-full w-[92%] max-w-md bg-white shadow-xl">
                <div className="flex items-center justify-between border-b p-4">
                    <div className="font-medium">设置</div>
                    <button className="text-sm text-zinc-600" onClick={onClose}>
                        关闭
                    </button>
                </div>

                <div className="h-[calc(100%-64px)] overflow-y-auto p-4 space-y-4">
                    <div className="space-y-2">
                        <div className="text-sm font-medium">System Prompt</div>
                        <textarea
                            className="w-full rounded-xl border p-3 text-sm outline-none focus:ring-2 focus:ring-blue-500"
                            rows={6}
                            value={settings.system_prompt}
                            onChange={(e) => onChange({ ...settings, system_prompt: e.target.value })}
                        />
                        <div className="flex items-center gap-2">
                            <button
                                className="rounded-xl border px-3 py-2 text-sm hover:bg-gray-50 disabled:opacity-50"
                                onClick={handleAutoPrompt}
                                disabled={promptGenerating}
                                title="使用当前模型扩写 System Prompt"
                            >
                                {promptGenerating ? "生成中..." : "自动完善"}
                            </button>
                            {promptError ? (
                                <div className="text-xs text-red-600">{promptError}</div>
                            ) : null}
                        </div>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-2">
                            <div className="text-sm font-medium">Model</div>
                            <select
                                className="w-full rounded-xl border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500"
                                value={settings.model}
                                onChange={(e) => onChange({ ...settings, model: e.target.value })}
                            >
                                {modelOptions.map((m) => (
                                    <option key={m} value={m}>
                                        {m}
                                    </option>
                                ))}
                            </select>
                        </div>

                        <div className="space-y-2">
                            <div className="text-sm font-medium">Temperature</div>
                            <div className="text-xs text-zinc-500">
                                当前：{fmtParam(settings.temperature, PARAM_MIN.temperature, 2)}
                            </div>
                            <input
                                type="range"
                                step="0.05"
                                min={PARAM_MIN.temperature}
                                max={2}
                                className="w-full"
                                value={settings.temperature}
                                onChange={(e) =>
                                    onChange({ ...settings, temperature: Number(e.target.value) })
                                }
                            />
                            <div className="text-[11px] text-zinc-500">
                                控制输出的随机性和创造性
                            </div>
                        </div>

                        <div className="space-y-2">
                            <div className="text-sm font-medium">Top P</div>
                            <div className="text-xs text-zinc-500">
                                当前：{fmtParam(settings.top_p, PARAM_MIN.top_p, 2)}
                            </div>
                            <input
                                type="range"
                                step="0.01"
                                min={PARAM_MIN.top_p}
                                max={1}
                                className="w-full"
                                value={settings.top_p}
                                onChange={(e) =>
                                    onChange({ ...settings, top_p: Number(e.target.value) })
                                }
                            />
                            <div className="text-[11px] text-zinc-500">
                                核采样，控制词汇选择的多样性
                            </div>
                        </div>

                        <div className="space-y-2">
                            <div className="text-sm font-medium">Frequency Penalty</div>
                            <div className="text-xs text-zinc-500">
                                当前：{fmtParam(settings.frequency_penalty, PARAM_MIN.frequency_penalty, 2)}
                            </div>
                            <input
                                type="range"
                                step="0.05"
                                min={PARAM_MIN.frequency_penalty}
                                max={2}
                                className="w-full"
                                value={settings.frequency_penalty}
                                onChange={(e) =>
                                    onChange({
                                        ...settings,
                                        frequency_penalty: Number(e.target.value),
                                    })
                                }
                            />
                            <div className="text-[11px] text-zinc-500">
                                频率惩罚，减少重复词汇的出现
                            </div>
                        </div>

                        <div className="space-y-2">
                            <div className="text-sm font-medium">Presence Penalty</div>
                            <div className="text-xs text-zinc-500">
                                当前：{fmtParam(settings.presence_penalty, PARAM_MIN.presence_penalty, 2)}
                            </div>
                            <input
                                type="range"
                                step="0.05"
                                min={PARAM_MIN.presence_penalty}
                                max={2}
                                className="w-full"
                                value={settings.presence_penalty}
                                onChange={(e) =>
                                    onChange({
                                        ...settings,
                                        presence_penalty: Number(e.target.value),
                                    })
                                }
                            />
                            <div className="text-[11px] text-zinc-500">
                                存在惩罚，鼓励讨论新话题
                            </div>
                        </div>
                    </div>

                    <div className="flex justify-end">
                        <button
                            className="rounded-xl border px-3 py-2 text-sm hover:bg-gray-50"
                            onClick={() =>
                                onChange({
                                    ...settings,
                                    ...DEFAULT_SAMPLING_PARAMS,
                                })
                            }
                        >
                            恢复默认参数
                        </button>
                    </div>

                    <div className="flex items-center justify-between rounded-xl border px-3 py-2">
                        <div className="text-sm font-medium">流式输出</div>
                        <button
                            className={[
                                "rounded-full px-3 py-1 text-xs",
                                settings.stream
                                    ? "bg-blue-600 text-white"
                                    : "bg-zinc-100 text-zinc-700",
                            ].join(" ")}
                            onClick={() => onChange({ ...settings, stream: !settings.stream })}
                        >
                            {settings.stream ? "已开启" : "已关闭"}
                        </button>
                    </div>

                    <div className="flex items-center justify-between rounded-xl border px-3 py-2">
                        <div className="text-sm font-medium">开发者模式</div>
                        <button
                            className={[
                                "rounded-full px-3 py-1 text-xs",
                                settings.developer_mode
                                    ? "bg-blue-600 text-white"
                                    : "bg-zinc-100 text-zinc-700",
                            ].join(" ")}
                            onClick={() =>
                                onChange({ ...settings, developer_mode: !settings.developer_mode })
                            }
                        >
                            {settings.developer_mode ? "已开启" : "已关闭"}
                        </button>
                    </div>

                    <div className="space-y-2">
                        <div className="text-sm font-medium">管理模型</div>
                        <div className="flex gap-2">
                            <input
                                className="flex-1 rounded-xl border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500"
                                placeholder="输入模型名，回车/添加"
                                value={newModel}
                                onChange={(e) => setNewModel(e.target.value)}
                                onKeyDown={(e) => {
                                    if (e.key === "Enter") {
                                        e.preventDefault();
                                        addModel();
                                    }
                                }}
                            />
                            <button
                                className="rounded-xl border px-3 py-2 text-sm hover:bg-gray-50"
                                onClick={addModel}
                            >
                                添加
                            </button>
                        </div>

                        <div className="text-xs text-zinc-500">
                            桌面拖拽排序；手机端长按后拖动排序。
                        </div>

                        <div className="space-y-2">
                            {modelOptions.map((m) => (
                                <div
                                    key={m}
                                    className={[
                                        "flex items-center justify-between rounded-xl border px-3 py-2 text-sm",
                                        dragging === m ? "bg-zinc-50" : "bg-white",
                                    ].join(" ")}
                                    draggable
                                    onDragStart={(e) => {
                                        setDragging(m);
                                        e.dataTransfer.effectAllowed = "move";
                                        e.dataTransfer.setData("text/plain", m);
                                    }}
                                    onDragEnd={() => setDragging(null)}
                                    onDragOver={(e) => e.preventDefault()}
                                    onDrop={(e) => {
                                        e.preventDefault();
                                        const from = e.dataTransfer.getData("text/plain");
                                        moveModel(from, m);
                                        setDragging(null);
                                    }}
                                >
                                    <div className="flex items-center gap-2">
                                        <span className="cursor-grab select-none">≡</span>
                                        <span>{m}</span>
                                        {m === settings.model ? (
                                            <span className="text-[11px] text-blue-600">当前</span>
                                        ) : null}
                                    </div>
                                    <button
                                        className="text-xs text-zinc-500 hover:text-zinc-800"
                                        onClick={() => deleteModel(m)}
                                    >
                                        删除
                                    </button>
                                </div>
                            ))}
                        </div>
                    </div>

                    <div className="text-xs text-zinc-500">
                        阶段二先做本地回显；阶段三会把这里的设置带去调用后端。
                    </div>
                </div>
            </div>
        </div>
    );
}
