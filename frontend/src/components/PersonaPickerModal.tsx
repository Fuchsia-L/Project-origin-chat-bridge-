import type { Persona } from "../types/persona";

export default function PersonaPickerModal({
    open,
    personas,
    onClose,
    onPick,
}: {
    open: boolean;
    personas: Persona[];
    onClose: () => void;
    onPick: (persona: Persona | null) => void;
}) {
    if (!open) return null;

    return (
        <div className="fixed inset-0 z-40">
            <div className="absolute inset-0 bg-black/30" onClick={onClose} />
            <div className="absolute left-1/2 top-1/2 w-[94%] max-w-2xl -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-white p-4 shadow-xl">
                <div className="mb-3 flex items-center justify-between">
                    <div className="font-medium">选择角色创建会话</div>
                    <button className="text-sm text-zinc-600" onClick={onClose}>
                        关闭
                    </button>
                </div>

                <div className="max-h-[60vh] space-y-2 overflow-y-auto">
                    <button
                        className="w-full rounded-xl border border-dashed px-3 py-3 text-left text-sm hover:bg-gray-50"
                        onClick={() => onPick(null)}
                    >
                        无角色
                    </button>
                    {personas.map((p) => (
                        <button
                            key={p.id}
                            className="w-full rounded-xl border px-3 py-3 text-left hover:bg-gray-50"
                            onClick={() => onPick(p)}
                        >
                            <div className="flex items-center gap-3">
                                {p.avatar_url ? (
                                    <img
                                        src={p.avatar_url}
                                        alt={p.name}
                                        className="h-10 w-10 rounded-full object-cover"
                                    />
                                ) : (
                                    <div className="h-10 w-10 rounded-full bg-zinc-200" />
                                )}
                                <div className="min-w-0">
                                    <div className="truncate text-sm font-medium">{p.name}</div>
                                    {p.description ? (
                                        <div className="truncate text-xs text-zinc-500">{p.description}</div>
                                    ) : null}
                                    {(p.tags ?? []).length > 0 ? (
                                        <div className="mt-1 flex flex-wrap gap-1">
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
                                </div>
                            </div>
                        </button>
                    ))}
                </div>
            </div>
        </div>
    );
}
