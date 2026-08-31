# Fastify + PostgreSQL + Redis 后端架构

日期：2026-08-31
状态：已实施

## 运行模型

生产环境由四个 Compose 服务组成：

- `gip-api`：Fastify REST/SSE API，同时托管构建后的静态前端。
- `gip-worker`：独立任务 Worker，消费 Redis 队列并调用供应商。
- `gip-postgres`：任务、图片元数据、Profile、收藏夹、应用状态、Outbox 和迁移记录的唯一权威数据源。
- `gip-redis`：会话、队列、热点缓存和实时事件传输；丢失后可从 PostgreSQL 重建。

API 与 Worker 使用同一镜像，通过显式命令启动：

```text
node server/api/main.mjs
node server/worker/main.mjs
```

浏览器 IndexedDB 只保存页面、任务和图片缓存，并作为浏览器迁移接口的来源，不承担业务权威或双向快照合并。

## 正式接口

所有业务请求均使用同源 `/api` 路由：

- `/api/auth/*`：登录、登出和会话检查。
- `/api/tasks/*`：分页列表、创建、重试、删除和收藏关系。
- `/api/images/*`：图片上传、原图和缩略图读取。
- `/api/profiles/*`：Profile 脱敏读取和更新。
- `/api/favorite-collections/*`：收藏夹管理。
- `/api/app-state`：设置与画廊草稿。
- `/api/events`：SSE 实时事件。
- `/api/migration/*`：浏览器缓存清单、图片、任务导入和完成确认。

写请求要求登录 Cookie、允许的 Origin 和 CSRF Token。API Key 只在 Worker 内存中解密，永不通过任务、Redis、SSE 或前端响应返回。

## 数据与任务流

任务创建在 PostgreSQL 事务中写入任务、Job 和 Outbox；分发器将 Outbox 投递到 Redis `pending` 队列。Worker 使用租约和幂等检查处理任务，将结果图片原子写入共享持久化目录，再提交任务状态和领域事件。API 通过 SSE 推送事件，前端收到后重新读取 PostgreSQL 权威状态。

任务列表按 `createdAt DESC, id DESC` 分页，每页固定 30 条，搜索、状态和收藏筛选均在服务端执行。Redis 仅作为可重建的队列、会话、缓存和事件通道。

## 部署

```sh
cd deploy/cloud
cp .env.example .env
docker compose up -d --build
```

必须配置 `LOGIN_TOKEN`、`CONFIG_ENCRYPTION_KEY`、`POSTGRES_PASSWORD` 和 `APP_ORIGIN`。API 与 Worker 共享 `gip-image-data` 图片卷，PostgreSQL 和 Redis 使用独立持久化卷。升级后可用 `docker compose config` 检查服务命令、依赖和环境变量。

## 旧数据升级说明

这是一次有意的兼容性断裂。切换到 Fastify 后，仓库不再提供旧 Node/SQLite 快照运行时、快照协议或旧 SQLite 迁移命令。升级前必须由部署方自行备份并处理旧 SQLite 数据、旧图片目录及浏览器缓存；仓库仅保留 `/api/migration/browser/*` 用于把浏览器缓存补充导入 PostgreSQL。旧数据处理完成后再启动正式 API/Worker，并核对 PostgreSQL、图片卷和前端显示。

## 可靠性与限制

- PostgreSQL 是唯一不可丢失的业务事实来源，Redis 清空后可重建队列和缓存。
- Worker 支持租约超时恢复和有限次数重试；不提供取消任务接口。
- API 与 Worker 必须访问同一图片卷，当前部署模型适合同一 Docker 主机。
- SSE 不是持久日志；断线后以前端重新查询 `/api/tasks` 为准。
- 单用户会话模型不提供组织、角色或多租户隔离。
