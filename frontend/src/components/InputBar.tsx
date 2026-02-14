import { useState } from "react";

export default function InputBar({
    onSend,
    disabled,
}: {
    onSend: (text: string) => void;
    disabled?: boolean;
}) {
    const [text, setText] = useState("");

    const send = () => {
        const t = text.trim();
        if (!t) return;
        onSend(t);
        setText("");
    };

    return (
        <div className="border-t bg-white p-3">
            <div className="flex gap-2">
                <input
                    className="flex-1 rounded-xl border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500"
                    placeholder="输入消息，回车发送…"
                    value={text}
                    disabled={!!disabled}
                    onChange={(e) => setText(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                            e.preventDefault();
                            send();
                        }
                    }}
                />
                <button
                    className="rounded-xl bg-blue-600 px-4 py-2 text-sm text-white disabled:opacity-50"
                    disabled={!!disabled}
                    onClick={send}
                >
                    发送
                </button>
            </div>
        </div>
    );
}
