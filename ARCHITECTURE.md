# Project Origin – Architecture

## 1. 概览
- 前端：React 19 + TypeScript + Vite + Tailwind，单页聊天界面，主要代码在 `frontend/src`。
- 后端：FastAPI，提供 OpenAI 兼容 `/api/chat` 与流式 `/api/chat/stream` 端点，代码在 `backend/app`。
- 状态存储：浏览器 `localStorage` + 服务器 PostgreSQL（会话云端同步 + 登录）。
- 目标：提供多会话、本地持久化的聊天体验，支持账号登录与云端同步，并将请求转发给可配置的 OpenAI 兼容 LLM 网关。

## 2. 前端架构（`frontend`）
### 2.1 入口与布局
- `src/main.tsx`：React 渲染入口。
- `src/App.tsx`：加载 `AuthScreen` 或 `Home`。
- `src/pages/Home.tsx`：页面主逻辑（状态、事件、数据流）。
- UI 组件：`components/ChatWindow.tsx`（消息气泡渲染 + raw/thinking 折叠）、`components/InputBar.tsx`（输入发送）、`components/SettingsDrawer.tsx`（模型与提示词管理）。
- 认证组件：`components/AuthScreen.tsx`（注册/登录）。
- 顶部栏：`Home` 的 header 为 sticky，始终固定在视口顶端。
- 会话编辑：支持编辑/删除单条消息、强制中断回复、重新生成；同一条回复可在多次生成结果间切换（`1/2` 标签）。

### 2.2 状态与持久化
- 核心存储封装：`src/store/chatStore.ts`
  - 默认设置 `defaultSettings`（模型 `gemini-3-pro-preview-11-2025`，温度 0.7，system_prompt 为空）。
  - 会话模型：`PersistedSession`（id/title/createdAt/updatedAt/messages/settings）。
  - 会话列表状态：`PersistedSessionsStateV1`，持久化键 `project-origin:sessions:v1`（按用户命名空间隔离）。
  - 迁移：若新存储为空，尝试从旧键 `project-origin:v1` 迁移。
  - API：`loadChatState`、`saveChatState`（节流 300ms）、`saveSessionStateImmediate`、`createSession`、`switchSession`、`renameSession`、`clearChatState`、`buildSyncPayloads`、`mergeRemoteSessions`。
  - 消息持久化过滤：不保存 `meta.isLoading`。
- 序列化工具：`src/store/persist.ts`
  - 读写 `localStorage`（按用户命名空间隔离），含模型列表键 `project-origin:models:v1` 与同步状态键 `project-origin:sync:v1`。
  - `createThrottledSaver` 防抖写入，减少存储频率。
- 认证存储：`src/store/authStore.ts`（access/refresh token + user）。
- 会话切换时的即时保存：`Home.handleSwitchSession` 在切换前调用 `saveSessionStateImmediate`。

### 2.3 API 客户端
- `src/api/chat.ts`：聊天请求（stream/post）。
- `src/api/auth.ts`：注册/登录/刷新/退出。
- `src/api/sync.ts`：会话 pull/push，同步冲突返回 `conflicts`。
- `streamChat(baseUrl, payload, onEvent)`：`fetch POST {baseUrl}/api/chat/stream`，解析 SSE 事件（meta/delta/thinking/usage/raw/done）并实时回调。
- 仅处理 HTTP 状态码与 JSON；上层负责错误显示。

### 2.4 交互与数据流（`Home.tsx`）
1. **启动**：登录后 `loadChatState` 载入会话、消息、设置；填充 `sessions` 与 `activeSessionId`。
2. **启动同步**：读取 `lastSyncAt` → `pull` → `mergeRemoteSessions` → 更新本地状态。
2. **发送流程**：`handleSend`
   - 本地追加 user 消息与 streaming assistant 占位；立即 `saveSessionStateImmediate`。
   - 组装历史消息为 `ChatRequest`，根据设置选择 `streamChat` 或 `postChat`。
   - 过程中按 delta 实时拼接回复；收到 thinking/usage/model 则更新 meta。
   - 切换会话时，正在进行的流式会话继续在后台写入该会话，不会被中断。
   - 支持强制中断（AbortController），中断后保留已输出内容与 token 使用情况（如有）。
   - 失败：将错误文案作为 assistant 消息展示并持久化。
3. **会话管理**：下拉切换、重命名（失焦/Enter）、新建会话、清空会话。
4. **同步**：本地变更节流后 `push`；若 `conflicts` 返回则拉取覆盖并提示。
5. **设置侧边栏**：`SettingsDrawer`
  - 模型列表：默认 `gpt-4o-mini/gpt-4o/gemini-3-pro-preview-11-2025`，可增删拖拽排序并持久化。
  - 自动完善 System Prompt：再次调用同一后端，以内置提示词请求当前模型生成更完整的 system prompt。
  - 温度/模型实时写入 `settings`，自动保存。

### 2.5 样式与构建
- Tailwind 配置：`tailwind.config.js`；全局样式 `src/index.css`.
- 构建/脚本：`npm run dev/build/lint/preview`（Vite）。

## 3. 后端架构（`backend/app`）
### 3.1 入口与中间件
- `main.py`：创建 FastAPI 应用，注册中间件/路由。
- `core/logging.py`：`request_id_middleware` 生成或透传 `x-request-id`，在响应头附带 `x-cost-ms`。
- `core/errors.py`：统一异常结构（`AppError`/`HTTPException`），响应含 `request_id`。
- `core/auth.py`：JWT 校验与 `get_current_user`。
- `core/security.py`：密码哈希与 token 生成/解析。

### 3.2 配置（`core/config.py`）
- 使用 `pydantic_settings.Settings`，读取 `.env`（样例见 `.env.example`）。
- 关键参数：`DATABASE_URL`、`JWT_SECRET`、`JWT_ACCESS_TTL`、`JWT_REFRESH_TTL`、`SYNC_MAX_SESSIONS`、`SYNC_MAX_BYTES`、`LLM_BASE_URL`、`LLM_API_KEY`、`LLM_MODEL`、`LLM_TEMPERATURE`、`LLM_TIMEOUT_S`、`LLM_SAFETY_BLOCK`、`APP_HOST/PORT`、`APP_DEBUG_RAW`（决定是否透出上游 raw 响应）。

### 3.3 路由与契约
- `routes/chat.py`：`POST /api/chat`（非流式），`POST /api/chat/stream`（SSE 流式）。
- `routes/auth.py`：`POST /api/auth/register`、`/login`、`/refresh`、`/logout`。
- `routes/sessions.py`：`GET /api/sessions/list`、`POST /api/sessions/pull`、`POST /api/sessions/push`。
- `schemas/chat.py`：
  - `ChatRequest`: system_prompt?, model?, temperature?, messages[{role: system|user|assistant, content}].
  - `ChatResponse`: reply{role, content}, request_id, usage{input_tokens/output_tokens/total_tokens}?, raw?（调试）。
- `schemas/auth.py`：注册/登录/刷新/退出请求与响应。
- `schemas/sessions.py`：`SessionPayload`、`Pull/Push` 契约。

### 3.4 业务层
- `services/chat_service.py`：
  - `run_chat(system_prompt, messages, model, temperature, request_id)`。
  - `run_chat_stream(...)`：解析上游流式数据并输出 SSE delta。
  - 将 system prompt 插入消息首位；落到下游使用的 `req_messages`。
  - 调用 LLM 客户端，解析 `choices[0].message.content` 为回复；兼容 prompt/completion/total token 字段；返回 (reply, usage, raw)。
  - 任何解析/网关错误封装为 `AppError`（HTTP 502）。

### 3.5 LLM 客户端
- `llm/client.py`：`OpenAICompatClient.chat_completions` 使用 `httpx.AsyncClient` 向 `{LLM_BASE_URL}/chat/completions` POST。
- 处理：
  - 传递 `Authorization: Bearer <LLM_API_KEY>`；可透传 `X-Request-Id`。
  - 非 2xx：尽量解析 JSON error message，否则用响应文本；抛出 `AppError`.
  - 成功：返回 JSON；解析失败同样抛错。
- 目前仅实现 OpenAI 兼容接口（`adapters.py` 为空，为未来多厂商适配预留）。

### 3.6 数据库
- `db.py`：Async SQLAlchemy 连接与 `init_db()`。
- `models.py`：
  - `User`、`RefreshToken`、`ChatSession`（复合主键 user_id + id）、`Embedding`（预留）。

### 3.7 部署与运行
- 开发脚本：`dev.bat` 激活 `.venv` 后运行 `uvicorn app.main:app --reload --port 8000`.
- 依赖：`fastapi`, `uvicorn[standard]`, `httpx`, `pydantic`, `pydantic-settings`, `python-dotenv`, `pytest`, `SQLAlchemy`, `asyncpg`, `passlib[bcrypt]`, `PyJWT`.

## 4. 端到端数据流
1. 用户在 `InputBar` 输入 → `Home.handleSend`。
2. 前端本地插入 user + streaming assistant 占位；立即保存到 `localStorage`。
3. 组装 `ChatRequest`（system_prompt/模型/温度 + 历史消息）→ `POST /api/chat/stream`.
4. FastAPI 生成 `request_id`，调用 `run_chat_stream` → `llm_client.chat_completions_stream` → 上游 LLM。
5. 后端将 delta/thinking/usage/raw 以 SSE 发送；前端实时拼接到最后一条 assistant 消息并更新 meta。
6. 流结束后清除 streaming 标记；会话切换/清空/重命名均同步更新 `sessions` 状态并持久化。
7. 登录后自动 `pull` 同步；本地变更后节流 `push`；若冲突则拉取覆盖并提示。

## 5. 数据与存储
- 浏览器 `localStorage`：
  - `project-origin:sessions:v1:{userId}`：会话列表 + activeId（含 messages/settings）。
  - `project-origin:models:v1:{userId}`：模型优先级列表。
  - `project-origin:sync:v1:{userId}`：`lastSyncAt`。
  - 旧版迁移键 `project-origin:v1:{userId}`（仅 messages + settings）。
- 服务器：PostgreSQL（users/refresh_tokens/sessions/embeddings）。
- 日志/追踪：`x-request-id` 与 `x-cost-ms` 头部便于链路排查；前端消息 `meta.request_id` 展示。

## 6. 依赖关系图（文字版）
- `frontend/src/pages/Home.tsx`
  - 依赖：`api/postChat` → 后端 `/api/chat`
  - 状态读写：`store/chatStore.ts`（封装 `persist.ts`）
  - UI：`ChatWindow`、`InputBar`、`SettingsDrawer`
- 后端 `routes/chat.py`
  - 依赖：`services/run_chat`
    - 调用：`llm/client.py`（httpx → LLM 网关）
  - 共享：`schemas/chat.py`（数据契约）、`core/config.py`（配置）、`core/logging.py`（request_id）、`core/errors.py`（统一错误）

## 7. 扩展与注意事项
- 认证/鉴权：已实现 JWT；上线需收紧 `allow_origins`。
- 输入/输出限制：未做长度校验与费控；需在前端或服务端增加字数/Token 限制、流式响应支持。
- 错误处理：前端以 assistant 气泡展示错误文本；可补充重试/回退。
- 多模型/供应商：`adapters.py` 空位用于封装不同厂商的请求/响应转换；前端模型列表已支持自定义排序。
- 日志与调试：`APP_DEBUG_RAW=true` 时返回上游原始 JSON，便于前端折叠查看；生产应设为 false。
- 测试：仅有 smoke 测试；建议增加 service 层和路由的集成测试，并对 `chatStore` 进行单元测试（可用 jsdom/localStorage mock）。

## 8. 快速运行（本地）
- 后端：在 `backend` 建立虚拟环境并填好 `.env`，`python -m uvicorn app.main:app --reload --port 8000`.
- 前端：`cd frontend && npm install && npm run dev`，默认向 `http://127.0.0.1:8000` 发送请求。
