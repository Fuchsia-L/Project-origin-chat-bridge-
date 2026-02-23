import type { AuthState } from "../store/authStore";
import { authorizedFetch } from "./auth";
export type Role = "user" | "assistant";

export type Usage = {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
};

export type ChatMessage = {
    role: Role;
    content: string;
    meta?: {
        request_id?: string;
        usage?: Usage | null;
        raw?: unknown | null;
    };
};

export type ChatRequest = {
    system_prompt: string;
    model: string;
    temperature?: number;
    top_p?: number;
    frequency_penalty?: number;
    presence_penalty?: number;
    session_id?: string | null;
    persona_id?: string | null;
    project_id?: string | null;
    messages: Array<{ role: Role; content: string }>;
};

export type ChatResponse = {
    reply: { role: Role; content: string };
    request_id: string;
    usage?: Usage | null;
    raw?: unknown | null;
};

async function chatFetch(
    baseUrl: string,
    path: string,
    payload: ChatRequest,
    signal?: AbortSignal,
    auth?: AuthState,
    onAuthUpdate?: (next: AuthState | null) => void
) {
    if (auth && onAuthUpdate) {
        return authorizedFetch(
            baseUrl,
            path,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
                signal,
            },
            auth,
            onAuthUpdate
        );
    }
    return fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal,
    });
}

export async function postChat(
    baseUrl: string,
    payload: ChatRequest,
    auth?: AuthState,
    onAuthUpdate?: (next: AuthState | null) => void
): Promise<ChatResponse> {
    const res = await chatFetch(baseUrl, "/api/chat", payload, undefined, auth, onAuthUpdate);

    if (!res.ok) {
        const text = await res.text();
        throw new Error(`HTTP ${res.status}: ${text}`);
    }
    return res.json();
}

export type StreamEvent =
    | { type: "meta"; request_id: string }
    | { type: "assembled"; messages: Array<{ role: string; content: string }> }
    | {
          type: "memory_status";
          status: {
              rounds?: number;
              summary?: { enabled: boolean; reason: string };
              memory_extract?: { enabled: boolean; reason: string };
              embedding?: { enabled: boolean; reason: string };
              layered_context?: {
                  enabled: boolean;
                  reason?: string;
                  session_bound?: boolean;
                  resolved?: { persona_id?: string | null; project_id?: string | null };
                  project_template?: { enabled: boolean; reason: string };
                  fallback_legacy_persona_memory?: boolean;
                  layers?: Record<string, { count: number; tokens_estimate: number; budget: number }>;
              };
          };
      }
    | { type: "delta"; content: string }
    | { type: "thinking"; content: string }
    | { type: "model"; model: string }
    | { type: "usage"; usage: Usage }
    | { type: "raw"; raw: unknown }
    | { type: "done" };

export async function streamChat(
    baseUrl: string,
    payload: ChatRequest,
    onEvent: (event: StreamEvent) => void,
    options?: { signal?: AbortSignal },
    auth?: AuthState,
    onAuthUpdate?: (next: AuthState | null) => void
) {
    const res = await chatFetch(
        baseUrl,
        "/api/chat/stream",
        payload,
        options?.signal,
        auth,
        onAuthUpdate
    );

    if (!res.ok || !res.body) {
        const text = await res.text();
        throw new Error(`HTTP ${res.status}: ${text}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    let gotDone = false;
    while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, "\n");
        let idx: number;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
            const chunk = buffer.slice(0, idx).trim();
            buffer = buffer.slice(idx + 2);
            if (!chunk) continue;
            const dataLines: string[] = [];
            for (const line of chunk.split("\n")) {
                if (!line.startsWith("data:")) continue;
                dataLines.push(line.slice(5).trimStart());
            }
            if (dataLines.length === 0) continue;
            const data = dataLines.join("\n").trim();
            if (!data) continue;
            try {
                const parsed = JSON.parse(data) as StreamEvent;
                onEvent(parsed);
                if (parsed.type === "done") gotDone = true;
            } catch {
                // ignore malformed event
            }
        }
    }
    if (!gotDone) onEvent({ type: "done" });
}
