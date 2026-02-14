import { useState, type FormEvent } from "react";
import type { AuthState } from "../store/authStore";
import { login, register, type AuthError } from "../api/auth";

const API_BASE = "http://127.0.0.1:8000";

export default function AuthScreen(props: { onAuth: (state: AuthState) => void }) {
    const [mode, setMode] = useState<"login" | "register">("login");
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");

    async function handleSubmit(e: FormEvent) {
        e.preventDefault();
        setError("");
        setLoading(true);
        try {
            const auth =
                mode === "login"
                    ? await login(API_BASE, email, password)
                    : await register(API_BASE, email, password);
            props.onAuth(auth);
        } catch (err: any) {
            const e = err as AuthError;
            if (mode === "login" && e?.status === 401) {
                setError("邮箱或密码错误");
                return;
            }
            if (mode === "register" && e?.status === 409) {
                setError("邮箱已注册");
                return;
            }
            if (e?.status === 400 && e?.message?.includes("Password too long")) {
                setError("密码过长（最多 72 字节）");
                return;
            }
            setError(e?.message ?? "请求失败");
        } finally {
            setLoading(false);
        }
    }

    return (
        <div className="min-h-screen flex items-center justify-center bg-gray-50">
            <div className="w-full max-w-sm border rounded-lg bg-white shadow-sm p-6">
                <div className="flex items-center justify-between mb-4">
                    <h1 className="text-lg font-semibold">Project Origin</h1>
                    <div className="text-sm">
                        <button
                            className={`px-2 py-1 rounded ${
                                mode === "login" ? "bg-gray-900 text-white" : "text-gray-500"
                            }`}
                            onClick={() => setMode("login")}
                            type="button"
                        >
                            登录
                        </button>
                        <button
                            className={`px-2 py-1 rounded ml-2 ${
                                mode === "register"
                                    ? "bg-gray-900 text-white"
                                    : "text-gray-500"
                            }`}
                            onClick={() => setMode("register")}
                            type="button"
                        >
                            注册
                        </button>
                    </div>
                </div>

                <form onSubmit={handleSubmit} className="space-y-3">
                    <div>
                        <label className="block text-xs text-gray-500 mb-1">邮箱</label>
                        <input
                            className="w-full border rounded px-3 py-2 text-sm"
                            value={email}
                            onChange={(e) => setEmail(e.target.value)}
                            placeholder="you@example.com"
                            type="email"
                            required
                        />
                    </div>
                    <div>
                        <label className="block text-xs text-gray-500 mb-1">密码</label>
                        <input
                            className="w-full border rounded px-3 py-2 text-sm"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            type="password"
                            required
                        />
                    </div>
                    {error ? <div className="text-sm text-red-600">{error}</div> : null}
                    <button
                        className="w-full bg-gray-900 text-white py-2 rounded text-sm"
                        type="submit"
                        disabled={loading}
                    >
                        {loading ? "处理中..." : mode === "login" ? "登录" : "注册"}
                    </button>
                </form>
            </div>
        </div>
    );
}
