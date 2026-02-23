# Project Origin – Architecture

## 1. 系统概览
- 前端：React 19 + TypeScript + Vite + Tailwind（`frontend/src`）。
- 后端：FastAPI + Async SQLAlchemy + Alembic（`backend/app`）。
- 数据：
  - 本地：`localStorage`（多会话、模型列表、同步状态、persona 缓存）。
  - 服务端：PostgreSQL（用户、会话、persona、记忆相关表）。
- 核心能力：
  - 聊天（流式/非流式）
  - 多会话云同步
  - Persona 角色系统
  - 记忆系统（摘要压缩 + 跨会话长期记忆 + embedding 召回）

## 2. 前端架构

### 2.1 入口与主页面
- `frontend/src/main.tsx`：应用入口。
- `frontend/src/App.tsx`：鉴权分流（`AuthScreen` / `Home`）。
- `frontend/src/pages/Home.tsx`：主状态机与数据流核心。

### 2.2 关键组件
- `ChatWindow.tsx`：消息渲染、变体切换、编辑/删除、developer 折叠区（thinking/raw/memory status/sent context）。
- `InputBar.tsx`：输入与发送（支持 Shift+Enter 换行）。
- `SettingsDrawer.tsx`：模型与采样参数配置。
- `PersonaManagerDrawer.tsx`：角色 CRUD、角色记忆查看/编辑/删除。
- `PersonaPickerModal.tsx`：按角色创建新会话。

### 2.3 前端状态与持久化
- `store/chatStore.ts`
  - 会话状态：`sessions + activeId + messages + settings`。
  - 提供 `create/switch/reorder/rename/delete` 等能力。
  - 删除采用 tombstone 同步语义。
  - 消息持久化保留 `thinking`（含 variant thinking），页面刷新后不丢失。
- `store/personaStore.ts`
  - persona 本地缓存 + 远端同步。
- `store/persist.ts`
  - 按用户命名空间写入 `localStorage`。

### 2.4 前端 API 层
- `api/chat.ts`：`/api/chat`、`/api/chat/stream`。
- `api/auth.ts`：登录/刷新/退出，`authorizedFetch` 自动刷新 token。
  - 连续 `401/403` 刷新失败达到阈值（当前 3 次）才清空登录态；网络抖动/超时不直接登出。
- `api/sync.ts`：会话 pull/push。
- `api/personas.ts`：persona CRUD。
- `api/memory.ts`：
  - 会话全局压缩
  - persona memory 列表/更新/删除
  - approve/reject 审批接口

### 2.5 Home 聊天主流程
1. 本地先插入 user + assistant 占位，并持久化。
2. 组装请求（含 `session_id`、`persona_id`、采样参数）。
3. 调用流式或非流式接口。
4. 响应结束后：
  - 清洗 `[内部回忆]... [回忆结束]` 前缀再展示。
  - developer 模式下可查看 assembled messages 与 memory status。
5. 空回复重试：
  - 若 5 秒内已收到空回复，最多重试 3 次，状态显示“重试中”。
6. 记忆审批弹窗：
  - 回复成功后拉取 `needs_review=true` 的记忆。
  - 支持逐条：确认写入（可编辑）、拒绝、跳过（下轮再出现）。

### 2.6 采样参数 UI（设置页）
- 四个参数均为滑杆：
  - `temperature`（0~2）
  - `top_p`（0~1）
  - `frequency_penalty`（-2~2）
  - `presence_penalty`（-2~2）
- 滑到最小值显示“未设置”，请求中不传该字段。
- 兼容策略：若 `temperature` 与 `top_p` 同时设置，默认仅发送 `temperature`。

## 3. 后端架构

### 3.1 入口与中间件
- `main.py`：注册路由与中间件。
- `core/logging.py`：`request_id` 与耗时头。
- `core/errors.py`：统一 `AppError`。

### 3.2 鉴权
- `core/auth.py`
  - `get_current_user`：强鉴权。
  - `get_optional_current_user`：聊天接口可选鉴权。
- `routes/chat.py`
  - `/api/chat`、`/api/chat/stream` 均使用可选鉴权。
  - 有效 JWT 时启用记忆增强；匿名请求走基础模式。

### 3.3 配置（`core/config.py`）
关键新增：
- 上下文管理：
  - `context_max_tokens`
  - `context_recent_rounds`
  - `context_summary_trigger`
  - `context_summary_batch_rounds`
  - `context_summary_min_tokens`
  - `context_summary_tail_round_index`
- 记忆提取：
  - `memory_extract_enabled`
  - `memory_extract_interval`
  - `memory_max_per_persona`
  - `memory_extract_require_confirm`
  - `memory_extract_model`（默认 `gemini-3-flash-preview-thinking`）
  - `memory_extract_fallback_model`
- Embedding：`embedding_*` 全套配置。
- 时区：`app_timezone`（默认 `UTC+8`）。
- 摘要模型：
  - `summary_model`（默认 `gemini-3-flash-preview-thinking`，未设置时回退 `llm_model`）。

### 3.4 数据模型（`models.py`）
- 既有：`User`、`RefreshToken`、`ChatSession`、`Persona`。
- 记忆新增：
  - `MemorySummary`：会话摘要快照（含覆盖消息范围、token 估算）。
  - `PersonaMemory`：长期记忆（`is_active` + `needs_review`）。
  - `MemoryEmbedding`：历史对话块向量（当前 Text JSON 向量存储）。

### 3.5 核心服务

#### 3.5.1 Context Assembler（`services/context_assembler.py`）
五层上下文组装：
1. system prompt
2. 长期记忆
3. 会话早期摘要
4. 最近对话原文
5. embedding 回忆

裁剪策略：按 token 预算和优先级裁剪。

长期记忆格式中包含“当前时间”，时区来自 `app_timezone`。
- 支持固定偏移写法（如 `UTC+8`、`UTC+08:00`），不依赖系统 zoneinfo 数据库。

#### 3.5.2 摘要压缩（`services/summary_service.py`）
- 触发前提：
  - 总轮数 >= `context_summary_trigger`
  - 压缩区间轮数 > 3
  - 压缩区间 token > `context_summary_min_tokens`
- 压缩区间：
  - 起点：上次摘要 `message_range_end`（不加一）
  - 终点：倒数第 `context_summary_tail_round_index` 轮对应结束位置（包含）
- 输出：新摘要写入 `memory_summaries`。
- 模型：优先使用 `summary_model`，与主聊天模型解耦。
- 支持手动全局压缩：`POST /api/memory/sessions/{session_id}/compress`。

#### 3.5.3 长期记忆提取（`services/memory_extract_service.py`）
- 触发：按 `memory_extract_interval` 轮次 + 首次补偿策略。
- 高低信号过滤：低信号内容直接跳过。
- 提取模型：
  - 主模型：`memory_extract_model`（默认 `gemini-3-flash-preview-thinking`）
  - 失败后 fallback：`memory_extract_fallback_model`
- 去重策略：
  - 提示词输入中包含“已有长期记忆”，要求无变化不重复输出。
  - 后端仍做键级冲突与 correction 处理（双保险）。
- 审批策略：
  - `memory_extract_require_confirm=true` 时，新记忆写入 `needs_review=true`，不直接参与上下文。
  - 审批前不会提前失活旧记忆；覆盖/更正在 approve 时执行，避免“未审批先覆盖”。

#### 3.5.6 记忆更正与合并审批（`routes/memory.py`）
- 待审核记忆查询会返回 `review_hints`，用于提示：
  - `请求更正“a”为“b”`
  - `请求合并“a”与“b”为“c”`
- `approve` 时执行自动规则：
  - 同键同内容：合并为已有记忆（更新时间/置信度），避免重复 active。
  - 同键不同内容：旧记忆失活，新记忆生效，必要时提升为 `correction`。
  - 多条同键：尝试合并为一条新内容并失活旧条目。

#### 3.5.4 Embedding（`services/embedding_service.py`）
- 对话切块、摘要、向量计算、入库。
- 召回时做余弦相似度过滤并注入回忆层。
- embedding 失败不阻塞主回复。

#### 3.5.5 Chat Service（`services/chat_service.py`）
- `run_chat` / `run_chat_stream`：
  - 登录用户：调用 `assemble_context`。
  - 匿名用户：退化为传统 `[system] + messages`。
- 回复后异步任务（不阻塞）：
  - `maybe_compress_session`
  - `maybe_extract_memories`
  - `chunk_and_store_session`（若开启）

## 4. 路由总览
- `POST /api/chat`
- `POST /api/chat/stream`
- `POST /api/auth/register|login|refresh|logout`
- `GET/POST /api/sessions/*`
- `GET/POST/PUT/DELETE /api/personas/*`
- `GET/PUT/DELETE /api/memory/personas/{persona_id}/memories*`
- `POST /api/memory/personas/{persona_id}/memories/{memory_id}/approve`
- `POST /api/memory/personas/{persona_id}/memories/{memory_id}/reject`
- `GET /api/memory/sessions/{session_id}/summary`
- `POST /api/memory/sessions/{session_id}/compress`
- `GET /api/memory/stats`

## 5. 调试与开发者模式
- `APP_DEBUG_RAW=true` 时，后端返回 raw 调试信息。
- 前端 developer 模式可查看：
  - thinking
  - raw
  - assembled messages（显示发送原文）
  - memory status

## 6. 运行要点
- 修改 `.env` 后需重启后端。
- 若使用时区功能，建议显式配置：
  - `APP_TIMEZONE=UTC+8`
- 数据库结构通过 Alembic 迁移维护。
