# Project Origin 本地/生产环境配置（PostgreSQL + Docker）

本文档面向小白，按步骤完成“数据库 + 迁移 + 后端 + 前端 + 同步 + 登录 + 未来扩展预留”。

---

## 0. 名词解释（非常简洁）
- PostgreSQL：真正存数据的数据库。
- Docker：一种“运行方式”，用容器把 PostgreSQL 跑起来，省去安装。
- 迁移（Alembic）：数据库结构的“版本管理”。
- 开发环境：你本机调试用（可自动建表）。
- 生产环境：线上给别人用（必须走迁移，安全可靠）。

---

## 1. 一键启动数据库（Docker）
在仓库根目录执行：

```powershell
docker compose up -d
```

这会启动一个 PostgreSQL 容器，并在本机暴露 `5432` 端口。

默认数据库参数：
- 用户名：`postgres`
- 密码：`postgres`
- 数据库：`project_origin`
- 连接地址：`127.0.0.1:5432`

---

## 2. 配置后端 `.env`
复制示例配置：

```powershell
Copy-Item backend\.env.example backend\.env
```

确保以下字段正确（默认可用）：

```
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/project_origin
JWT_SECRET=change_me
APP_ENV=development
DB_AUTO_CREATE=true
```

**说明：**
- `APP_ENV=development`：开发环境
- `DB_AUTO_CREATE=true`：开发环境可以自动建表
- `JWT_SECRET`：上线时必须改成强随机字符串

---

## 3. 安装后端依赖并运行迁移
进入 `backend` 目录：

```powershell
cd backend
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
```

初始化数据库（迁移）：

```powershell
alembic upgrade head
```

> 如果你之前用 `create_all` 生成过旧数据库：  
> 可以先执行 `alembic stamp head`，再执行新增迁移。

---

## 4. 启动后端
在 `backend` 目录：

```powershell
python -m uvicorn app.main:app --reload --port 8000
```

后端默认地址：`http://127.0.0.1:8000`

---

## 5. 启动前端
在 `frontend` 目录：

```powershell
cd frontend
npm install
npm run dev
```

前端默认地址：`http://127.0.0.1:5173`

---

## 6. 同步 + 登录验证（最小验证）
1. 前端注册一个账号（邮箱 + 密码）。
2. 登录后创建/编辑会话。
3. 刷新页面或开第二个浏览器登录同账号。
4. “立即同步”，确认会话一致。

---

## 7. 生产环境推荐设置（上线必看）
生产环境必须收紧：

```
APP_ENV=production
DB_AUTO_CREATE=false
JWT_SECRET=一个强随机字符串
CORS_ALLOW_ORIGINS=https://你的域名
```

同时建议：
- `SYNC_MAX_BYTES` 和 `SYNC_MAX_SESSIONS` 设置上限
- `PASSWORD_MIN_LENGTH` 设置 ≥ 8

---

## 8. 删除同步（墓碑机制）
删除会话不会立即从数据库消失，而是标记 `deleted_at`：
- 这样其他设备能知道“这个会话被删了”
- 默认 30 天后自动清理（可通过 `SESSION_TOMBSTONE_TTL_DAYS` 配置）

---

## 9. 未来扩展预留（你关心的方向）

### 9.1 微信 / QQ / 小红书接入
路线建议：
1. 先保留邮箱密码登录（已完成）
2. 后续新增 OAuth 或 API 登录模块（单独新路由）
3. 用户表结构不需要推翻，只需新增 OAuth 关联表

### 9.2 API 调用 & 文档
FastAPI 自带 Swagger 文档：
- `http://127.0.0.1:8000/docs`
- 未来可导出 OpenAPI 文档给第三方

### 9.3 LLM 记忆检索（向量存储）
已预留：
- `embeddings` 表
- `EMBEDDINGS_ENABLED` 功能开关
后续只需：
1. 安装 `pgvector`
2. 加 `embedding_vector` 字段为向量类型
3. 新增 `memory.search` 和 `memory.upsert` 接口

---

## 10. 常见问题
**Q: Docker 数据会不会丢？**  
不会，只要不删除 volume（默认有持久化卷 `project_origin_pgdata`）。

**Q: 为什么生产环境不能自动建表？**  
因为生产环境必须可控、可回滚，迁移才是标准做法。

**Q: 我不会 Alembic 怎么办？**  
只需要记住：
```
alembic upgrade head
```
其他都不用管。

