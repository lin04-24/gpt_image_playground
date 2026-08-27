# Redis + PostgreSQL 后端重构设计报告

日期：2026-08-27
状态：设计完成，待实施计划
适用项目：gpt-image-playground

## 1. 摘要

本次重构把项目从“浏览器直接调用生图 API、IndexedDB 为主要数据源、SQLite 快照用于可选云同步”调整为“服务端统一接收和执行任务、PostgreSQL 为唯一权威数据源、Redis 提供队列与缓存、服务端目录保存图片”的正式后端架构。

重构后的核心原则如下：

1. 前端不再持有或调用供应商 API Key。
2. PostgreSQL 保存所有不可丢失的业务事实。
3. Redis 只保存可重建的会话、队列索引、热点缓存和实时事件。
4. 原图和缩略图保存在服务端持久化目录，不进入 PostgreSQL 或 Redis。
5. 所有生图路径，包括画廊、编辑、多图、Agent、fal.ai 和自定义异步供应商，都经过同一套后端任务系统。
6. 任务创建使用 PostgreSQL Outbox 解决数据库与 Redis 的双写一致性问题。
7. Redis 队列采用 `pending` 和 `processing` List、数据库租约和幂等检查，支持 Worker 崩溃恢复。
8. 首页按任务分页，每页固定 30 个任务卡片；每张卡片保留该任务的全部输出图。
9. 升级必须迁移现有 SQLite、图片目录以及浏览器 IndexedDB 中尚未同步的数据。

## 2. 当前实现与可复用边界

### 2.1 当前数据与执行方式

现有项目具有以下实现：

- `src/store.ts` 负责任务创建、供应商调用、Agent 编排、任务恢复、收藏和大量 UI 状态。
- `src/lib/db.ts` 使用 IndexedDB 保存任务、原图、缩略图和 Agent 对话。
- `src/lib/imageCache.ts` 已有原图按需加载、缩略图缓存、订阅通知和后台补全逻辑。
- `src/lib/api.ts`、`src/lib/openaiCompatibleImageApi.ts`、`src/lib/falAiImageApi.ts`、`src/lib/agentApi.ts` 和相关模块包含现有供应商请求、响应解析与错误兼容逻辑。
- `src/lib/apiProfiles.ts` 包含多供应商、模型、Agent 配置和自定义供应商规范化逻辑。
- `src/lib/taskState.ts` 包含任务状态补丁等纯逻辑。
- `src/lib/favoriteState.ts` 包含收藏夹兼容和规范化逻辑。
- `server/index.mjs` 使用 Node 22 内置 SQLite 保存一条完整快照 JSON，并把图片保存到独立目录。
- `server/cloudPagination.mjs` 已实现按 `createdAt DESC, id DESC` 排序的服务端分页和搜索、状态、收藏过滤。
- `src/lib/cloudSync.ts` 已实现云端分页、缩略图渐进加载、冲突合并和远端原图按需加载。
- `TaskGrid.tsx` 目前仍将已加载任务在浏览器内全量排序、过滤并渲染。

### 2.2 复用策略

本次不重新发明已有业务规则，按以下方式迁移：

- 保留 `TaskRecord`、`TaskParams`、Agent 对话和供应商配置的现有语义，新增后端 DTO 时以这些类型为兼容基线。
- 迁移并复用现有供应商请求构造、响应解析、参数兼容、透明背景处理、fal.ai 恢复和自定义供应商映射逻辑。
- 将纯逻辑从浏览器模块移动到共享或服务端模块，不复制一套同名实现。
- 保留前端 `imageCache` 的内存和 IndexedDB 缓存职责，但远端加载器改为新的图片 API。
- 保留现有收藏夹规则、错误筛选语义、任务重试“创建新任务”的行为和 Agent 输出关联规则。
- 现有 SQLite 云同步分页代码只用于迁移期兼容，不作为新 PostgreSQL API 的长期实现。

## 3. 目标与非目标

### 3.1 目标

- PostgreSQL 成为任务、配置、收藏、Agent 对话和图片元数据的唯一权威数据源。
- 支持历史任务持续增长，不依赖浏览器加载完整任务集合。
- 支持峰值同时提交 20 个任务，Worker 全局并发默认 6，并可通过环境变量调整。
- 任务在 API 或 Worker 重启、Redis 短暂不可用、网络中断后能够恢复。
- 首页第一页和第二页优先命中 Redis JSON 缓存。
- 所有列表搜索、状态筛选和收藏夹筛选覆盖完整服务端数据集。
- API Key 加密存储且永不返回前端。
- 提供独立、幂等、可预览和可核对的旧数据迁移流程。
- 保持现有任务卡、详情、复用、重试、收藏、多图输出和 Agent 主要交互语义。

### 3.2 非目标

- 不支持多用户、组织、角色或数据隔离模型。
- 不支持取消任务。
- 不引入 Kafka、RabbitMQ、BullMQ 等额外消息系统。
- 不把图片二进制存入 PostgreSQL 或 Redis。
- 不在本次重构中改用 S3 或其他对象存储。
- 不承诺对不支持幂等键的上游供应商实现严格的端到端 exactly-once 调用。
- 不保留浏览器直接调用供应商 API 的旧执行模式。
- 不继续支持只有静态前端、没有本项目后端的完整运行方式。

## 4. 已确认的设计决策

| 主题 | 决策 |
|---|---|
| 数据权威 | PostgreSQL 是唯一权威数据源 |
| 浏览器存储 | IndexedDB 仅作为页面与图片缓存 |
| 图片存储 | 服务端持久化目录保存原图和缩略图 |
| 任务执行 | 所有生图与 Agent 路径迁移到后端 Worker |
| 后端技术 | Fastify + TypeScript + `pg` + `redis` + `sharp` |
| 容器 | API 与 Worker 使用同一镜像、不同启动命令和独立容器 |
| 队列 | Redis `pending` / `processing` List + PostgreSQL 租约 |
| 自动重试 | 首次之外最多自动重试 2 次，最多执行 3 次 |
| 并发 | Worker 全局并发可配置，默认 6 |
| 分页 | 按任务分页，每页固定 30 个任务 |
| 排序 | `createdAt DESC, id DESC` |
| UI | 页码 + 上一页 + 下一页 |
| 搜索 | PostgreSQL `pg_trgm` 包含搜索，覆盖完整历史 |
| 实时更新 | REST 创建和查询，SSE 推送状态、缩略图和 Agent 增量文本 |
| 会话 | Redis 会话，HttpOnly + SameSite Cookie，默认 30 天 |
| API Profile | PostgreSQL 保存元数据和加密 API Key，前端只读脱敏信息 |
| Redis 持久化 | 同时开启 AOF `everysec` 和 RDB |
| 缓存 | 首页前两页 30 秒，任务详情 60 秒，写操作主动失效 |
| 删除 | PostgreSQL 事务删除元数据，Redis 清理队列异步删除文件 |
| 迁移 | 维护窗口、只读旧数据、幂等命令、预览和数量核对 |

## 5. 总体架构

### 5.1 运行单元

系统由以下运行单元组成：

1. **React 前端**
   - 调用本项目 REST API。
   - 通过 SSE 接收实时事件。
   - 使用 IndexedDB 缓存可见任务、原图和缩略图。
   - 不保存供应商 API Key，不直接调用供应商。

2. **Fastify API 容器**
   - 登录与会话校验。
   - 任务创建、分页、详情、删除和手动重试。
   - API Profile、收藏夹、应用设置和 Agent 对话接口。
   - 图片上传和受保护的图片读取。
   - SSE 连接管理。
   - Outbox 分发和 Redis 缓存读取可作为独立后台循环运行，但不执行供应商任务。

3. **Worker 容器**
   - 消费生成、Agent、缩略图和文件清理任务。
   - 调用上游供应商。
   - 保存原图和缩略图。
   - 更新 PostgreSQL 状态并产生领域事件。
   - 扫描超时租约并恢复中断任务。

4. **PostgreSQL 容器**
   - 保存所有不可丢失的业务事实。
   - 提供事务、约束、索引、Outbox 和迁移记录。

5. **Redis 容器**
   - 保存登录会话。
   - 保存任务队列和任务时间 ZSet。
   - 保存热点 JSON、收藏集合和脱敏配置缓存。
   - 在 Worker 与 API 之间传递实时事件。

6. **图片持久化卷**
   - 保存原图、缩略图和短期临时文件。
   - API 读取，Worker 读写。

### 5.2 核心数据流

```text
前端
  -> REST 创建任务
  -> PostgreSQL 事务写入 task + job + outbox
  -> Outbox 分发器推送 Redis pending List
  -> Worker 使用 BLMOVE 转入 processing List
  -> Worker 调用供应商并原子写入图片文件
  -> PostgreSQL 事务写入输出、任务状态和领域事件
  -> Redis Pub/Sub
  -> Fastify SSE
  -> 前端更新当前页面
```

### 5.3 同一镜像、不同进程

API 和 Worker 使用同一个构建镜像，避免重复构建和版本漂移：

```text
API:    node dist/server/api/main.js
Worker: node dist/server/worker/main.js
Migrate: node dist/server/migrations/run.js
Legacy: node dist/server/legacy/migrateLegacy.js
```

API 与 Worker 共享领域类型、数据库访问、Redis 键定义、供应商适配器和图片存储模块，但不共享进程内状态。

## 6. 数据权威与一致性约束

系统必须始终满足以下不变量：

1. PostgreSQL 中不存在的任务，不能仅因为 Redis 中存在成员而对外显示。
2. Redis 可以被清空并从 PostgreSQL 重建，不得保存唯一副本。
3. 图片文件完成临时写入、校验和原子重命名后，才能提交对应图片元数据。
4. 删除任务时先提交数据库删除，再异步删除无引用文件。
5. API Key 不得出现在任务 JSON、Redis、SSE、普通日志或前端响应中。
6. 任务创建与入队通过 Outbox 保证至少一次投递，Worker 必须幂等。
7. 列表排序在 PostgreSQL 与 Redis 中统一为 `created_at DESC, id DESC`。
8. `queued`、`running`、`done`、`error` 是任务的完整状态集合，不存在 `cancelled`。
9. 排队或运行中的任务不能删除，避免把“删除”隐式变成取消；API 返回 `409`。
10. 手动重试沿用现有行为：创建新任务 ID，原失败任务保留。

## 7. PostgreSQL 数据模型

### 7.1 通用约定

- 时间统一使用 `TIMESTAMPTZ`，API 返回 Unix 毫秒或 ISO 字符串时保持单一约定。
- 现有任务、图片和对话 ID 使用 `TEXT` 保存，迁移时不改写 ID。
- 新内部记录使用 UUID。
- 高频过滤字段使用普通列；供应商特有、低频展示字段使用 `JSONB`。
- 所有外键明确配置删除行为，不依赖应用层猜测。
- 启用 `pg_trgm` 扩展。

### 7.2 主要表

#### `app_state`

单用户全局应用状态：

- `id`，固定为 1。
- `settings`：不含 API Key 的设置 JSON。
- `gallery_draft`、`agent_drafts`：草稿 JSON，仅保存图片 ID。
- `active_mode`、`active_agent_conversation_id` 等 UI 持久状态。
- `updated_at`。

浏览器展示偏好仍可本地缓存，但服务端记录是恢复和跨浏览器的一致来源。

#### `api_profiles`

- `id`。
- `name`。
- `provider`。
- `active_version_id`。
- `sort_order`。
- `deleted_at`，软删除。
- `created_at`、`updated_at`。

#### `api_profile_versions`

每次影响执行行为的配置修改创建不可变版本：

- `id`。
- `profile_id`。
- `config`：base URL、模型、模式、超时、自定义映射等经过脱敏的非密钥配置。
- `encrypted_secrets`：API Key、自定义鉴权请求头和其他明确标记为密钥的字段。
- `encryption_key_id`。
- `nonce`、`auth_tag`。
- `created_at`。

任务引用具体版本，而不是执行时读取一个可能已经变化的配置。删除 Profile 只阻止新任务使用，已有任务版本仍可读取。

#### `tasks`

核心列：

- `id`。
- `status`：`queued | running | done | error`。
- `prompt`。
- `params JSONB`。
- `api_profile_id`、`api_profile_version_id`。
- `provider`、`api_mode`、`api_model`、`api_profile_name`：非敏感执行快照。
- `source_mode`：画廊或 Agent。
- `agent_conversation_id`、`agent_round_id`、`agent_message_id`。
- `transparent_output`、`transparent_prompt`。
- `external_job_data JSONB`：fal.ai 或自定义异步任务 ID、endpoint 和轮询状态。
- `result_metadata JSONB`：实际参数、改写提示词、原始 URL 等现有低频字段。
- `output_errors JSONB`。
- `error`。
- `created_at`、`updated_at`、`started_at`、`finished_at`。
- `elapsed_ms`。
- `version`：每次可见状态变化递增，用于缓存和客户端补齐。

索引：

- `(created_at DESC, id DESC)`。
- `(status, created_at DESC, id DESC)`。
- `(api_profile_id)`。
- `(agent_conversation_id, agent_round_id)`。
- `GIN` 搜索索引。

搜索文档由提示词、参数文本、任务错误和输出错误组成。更新这些字段时同步更新搜索列。

#### `images`

- `id`：保留现有哈希 ID。
- `mime_type`。
- `storage_path`。
- `thumbnail_path`。
- `thumbnail_mime_type`。
- `thumbnail_version`。
- `source`。
- `width`、`height`。
- `byte_size`。
- `content_sha256`：文件校验元数据，不包含图片内容。
- `thumbnail_status`：`queued | ready | error`。
- `created_at`。

`storage_path` 必须是相对于图片根目录的受控路径，API 不接受客户端直接提交路径。

#### `task_images`

统一表示任务与图片的关系：

- `task_id`。
- `image_id`。
- `role`：`input | mask_target | mask | output | transparent_original | stream_partial`。
- `position`。
- `metadata JSONB`：输出实际参数、改写提示词或失败槽位信息。

唯一约束按 `task_id + role + position` 设置。该表替代在多个位置重复维护图片引用数组，并支持安全判断图片是否仍被引用。

#### `draft_images`

保存画廊草稿和 Agent 输入草稿对图片的引用：

- `draft_key`：画廊固定键或 Agent conversation ID。
- `image_id`。
- `role`：`input | mask_target | mask`。
- `position`。

`app_state` 中的草稿 JSON 只保存展示和输入状态，图片清理必须以该关系表为依据，不能通过扫描 JSON 猜测引用。

#### `favorite_collections`

- `id`、`name`。
- `is_default`。
- `created_at`、`updated_at`。

#### `task_favorite_collections`

- `task_id`。
- `collection_id`。
- 复合主键。

任务是否收藏由关系是否存在推导，不再同时维护容易不一致的布尔值和数组。API DTO 仍可返回兼容的 `isFavorite` 和 `favoriteCollectionIds`。

#### Agent 表

- `agent_conversations`：标题、活动轮次、创建和更新时间。
- `agent_rounds`：父轮次、状态、请求参数、response ID、response output、错误和时间。
- `agent_messages`：角色、文本、轮次、输入图片关系和时间。
- `agent_message_images`：消息输入图、遮罩和顺序关系。
- `agent_message_tasks`：消息与输出任务的稳定关联和顺序。

Agent 增量文本不逐 token 写数据库。Worker 在固定时间或字符阈值下批量保存检查点，工具调用边界必须立即持久化。

#### `jobs`

Redis 队列的权威记录：

- `id`。
- `kind`：`generation | agent | thumbnail | file_cleanup`。
- `task_id` 或其他目标 ID。
- `status`：`queued | processing | done | error`。
- `payload JSONB`。
- `attempt_count`。
- `max_attempts`，默认 3。
- `available_at`。
- `lease_owner`、`lease_expires_at`。
- `last_error`。
- `created_at`、`updated_at`、`finished_at`。

#### `job_attempts`

记录每次真实执行：

- `job_id`、`attempt_no`。
- `worker_id`。
- `started_at`、`finished_at`。
- `outcome`。
- `error_class`、脱敏后的 `error_message`。

#### `outbox_events`

- `id`。
- `event_type`。
- `aggregate_type`、`aggregate_id`。
- `payload JSONB`。
- `available_at`。
- `attempt_count`。
- `delivered_at`。
- `created_at`。

任务创建、列表索引更新、缓存失效、SSE 领域事件和清理任务都通过 Outbox 驱动。

#### 迁移表

- `migration_runs`：一次预览或正式迁移的状态、计数、开始和结束时间。
- `legacy_import_items`：来源类型、来源 ID、内容摘要、导入结果和错误，用于幂等重跑。
- `schema_migrations`：数据库结构版本。

### 7.3 列表修订号

`app_meta` 保存单调递增的 `task_list_revision`。任何可能影响任务列表内容、排序、搜索、状态或收藏过滤的事务都递增该值，并把新修订号写入 Outbox。

API 只有在 Redis 中的任务索引修订号与 PostgreSQL 一致时才使用 ZSet 和页面缓存；不一致时回退 PostgreSQL 并触发修复，避免返回已知过期数据。

## 8. Redis 设计

### 8.1 键命名

所有键使用项目命名空间，例如 `gip:`，避免与其他容器或未来实例冲突。

| 用途 | 键示例 | 类型 |
|---|---|---|
| 会话 | `gip:session:<token-hash>` | Hash/String |
| 登录限流 | `gip:auth:attempts:<ip>` | String |
| 生成待处理 | `gip:queue:generation:pending` | List |
| 生成处理中 | `gip:queue:generation:processing` | List |
| Agent 待处理 | `gip:queue:agent:pending` | List |
| 缩略图待处理 | `gip:queue:thumbnail:pending` | List |
| 文件清理待处理 | `gip:queue:cleanup:pending` | List |
| 任务时间索引 | `gip:tasks:created` | ZSet |
| 索引修订号 | `gip:tasks:revision` | String |
| 首页缓存 | `gip:cache:tasks:<revision>:page:<n>` | String JSON |
| 任务详情 | `gip:cache:task:<id>:<version>` | String JSON |
| 收藏集合 | `gip:favorite:collection:<id>` | Set |
| 脱敏 Profile | `gip:profiles:public` | Hash |
| 实时事件 | `gip:events` | Pub/Sub channel |
| SSE 序号 | `gip:events:sequence` | String counter |

队列项只保存小型 JSON：

```json
{"jobId":"...","kind":"generation","targetId":"task-id"}
```

Worker 收到后必须从 PostgreSQL 重新读取 job、task 和配置版本，不信任 Redis payload 中的业务数据。

### 8.2 ZSet 分页

- 成员：任务 ID。
- score：`created_at` 的 Unix 毫秒。
- 同分值时 Redis 对成员进行字节字典序排序；PostgreSQL 的任务 ID 排序和索引显式使用 `COLLATE "C"`，确保 `ZREVRANGE` 与 `id DESC` 保持一致。
- 第 `page` 页范围：`start = (page - 1) * 30`，`stop = start + 29`。
- 总数使用 `ZCARD`。
- 取得 ID 后从任务详情缓存或 PostgreSQL 批量读取，并严格按 ZSet ID 顺序组装。

如果发现 ZSet ID 在 PostgreSQL 中不存在，API 移除该成员、记录告警并补齐本页；如果修订号不一致，整页回退 PostgreSQL。

### 8.3 热点缓存

- 无筛选首页第 1 页和第 2 页：完整 JSON，TTL 30 秒。
- 高频任务详情：完整 JSON，TTL 60 秒。
- JSON 包含任务、分页元数据和图片 API URL，不包含图片 base64 或二进制。
- 缓存键包含列表修订号或任务版本，因此写入后旧缓存自然不可达。
- 创建、状态更新、收藏变化和删除仍主动删除当前热点键，TTL 只是故障兜底。
- Redis 不可用时全部回退 PostgreSQL，不影响数据正确性。

### 8.4 收藏与配置缓存

- 收藏夹关系以 PostgreSQL 为准，Redis Set 用于收藏概览、计数和高频成员判断。
- Profile Hash 只保存脱敏元数据，不保存密文，更不保存解密后的 API Key。
- 缓存缺失时从 PostgreSQL 重建。

### 8.5 Redis 持久化

- 开启 AOF，策略 `appendfsync everysec`。
- 同时开启 RDB 快照。
- Redis 数据目录挂载独立卷。
- 恢复后执行队列、ZSet、收藏 Set 和公共 Profile 缓存核对。
- 即使 AOF 与 RDB 都不可用，仍可从 PostgreSQL 重建队列和索引；会话失效时用户需要重新登录。

## 9. 队列、租约与重试

### 9.1 入队协议

创建任务时在同一 PostgreSQL 事务中：

1. 插入 `tasks(status = queued)`。
2. 插入 `jobs(status = queued)`。
3. 插入 `outbox_events(event_type = job.enqueue)`。
4. 递增任务列表修订号并插入索引更新事件。

事务提交后 Outbox 分发器执行 `RPUSH pending`。如果 Redis 写入成功但 Outbox 确认失败，事件会重复发送；Worker 根据 job ID 和数据库状态忽略重复项。

### 9.2 消费协议

Worker 使用阻塞移动而非 `BLPOP`：

```text
BLMOVE pending processing RIGHT LEFT 5
```

取得队列项后：

1. 查询 PostgreSQL job。
2. 若 job 已完成、失败或由其他 Worker 持有，移除当前重复项并结束。
3. 使用条件更新把 job 从 `queued` 改为 `processing`，设置 `lease_owner` 和 `lease_expires_at`。
4. 创建 `job_attempts` 记录。
5. 执行业务逻辑。
6. 数据库事务提交成功后，`LREM processing 1 <exact-payload>`。

Redis List 只表示“需要尽快处理”，真实状态由 PostgreSQL 控制。

### 9.3 崩溃恢复

租约扫描器定期查询：

- `jobs.status = processing`
- `lease_expires_at < now()`

符合条件的 job 被重新置为 `queued`，清除租约并创建新的 Outbox 入队事件。Redis 中遗留的 processing 项可异步 `LREM`；即使遗留，幂等检查也会忽略。

Worker 执行长任务时定期续租。续租失败必须停止继续提交新的数据库结果，避免失去所有权后双写。

### 9.4 自动重试

最多执行 3 次：首次 + 2 次自动重试。

默认退避：

- 第一次重试：5 秒。
- 第二次重试：10 秒。

基础延迟可通过环境变量配置，公式为指数退避并加入小幅随机抖动。

可重试错误：

- 网络连接失败。
- 请求超时。
- HTTP 429。
- HTTP 5xx。
- 图片文件系统的短暂 I/O 错误。
- 可确认未完成的异步供应商轮询错误。

不可重试错误：

- 参数校验失败。
- API Key、权限或配额错误中的明确永久错误。
- HTTP 400、401、403、422。
- 输入图片或遮罩不存在。
- 响应结构明确不符合配置映射。
- Profile 已删除且找不到任务引用的版本。

### 9.5 上游幂等限制

- 供应商支持 idempotency key 时使用 job ID。
- fal.ai 和自定义异步服务商在取得外部 task ID 后立即持久化，后续只轮询该 ID。
- 同步供应商若在“上游已成功但本地尚未提交”时 Worker 崩溃，可能发生重复调用和重复计费。系统通过输出存在检查、租约和供应商幂等键降低风险，但无法对不支持幂等的上游提供绝对保证。

## 10. Worker 任务类型

### 10.1 生成任务

- 全局并发由 `WORKER_CONCURRENCY` 控制，默认 6。
- 峰值 20 个任务可以同时提交，超出并发的任务保持 `queued`。
- 一个 Task 是分页、收藏、重试和删除的业务单元。
- 一个 Task 内可以包含多张输出图，输出顺序保存在 `task_images.position`。
- 部分输出失败时，任务可保持 `done` 并保存 `output_errors`，延续当前错误筛选语义。

### 10.2 fal.ai 与自定义异步任务

Worker 不在长时间轮询期间占用一个生成并发槽：

1. 提交上游任务并保存外部 task ID。
2. 将 job 设置为等待轮询，并设置下一次 `available_at`。
3. 释放当前执行槽。
4. 到期后重新入队查询结果。

上游完成后按普通生成结果流程写入文件、图片元数据和任务状态。

### 10.3 缩略图任务

- 原图完成入库后创建独立 thumbnail job。
- 使用 `sharp` 复用现有缩略图最大尺寸、质量和版本语义。
- 缩略图写入临时文件后原子重命名。
- 任务可以先进入 `done`，卡片显示占位图；缩略图完成后发送 `thumbnail.ready` SSE 事件。
- 缩略图失败不回滚原图和任务，只记录状态并按统一策略重试。

### 10.4 文件清理任务

删除事务完成后：

1. 查询已无任何任务、对话或草稿引用的图片。
2. 创建 `file_cleanup` job。
3. Worker 删除原图和缩略图。
4. 删除成功后清理最终图片元数据，或将图片记录标记为已删除。

文件删除失败可重试。孤立文件审计命令定期比较数据库与目录并生成报告。

## 11. Agent 模式后端化

### 11.1 编排位置

Agent 的 Responses API 调用、工具调用解析、`generate_image_batch`、`continue_generation`、引用图片解析和轮次恢复全部迁移到 Worker。前端只提交用户消息和图片 ID。

### 11.2 持久化边界

- 创建用户消息和 Agent round 后再入队。
- Worker 开始时把 round 改为 `running`。
- 文本增量通过 Redis 事件发送。
- 文本每 500 毫秒或累计 4 KB 保存一次检查点，二者先到者触发。
- 每个工具调用、child task ID、response ID 和 response output 必须在继续下一轮之前提交。
- Agent 子生图任务使用同一个 generation queue，不直接调用浏览器逻辑。
- Agent 等待子任务时释放 Agent Worker 执行槽，通过数据库状态和新 job 恢复。

### 11.3 Agent 恢复

- 在尚未取得上游 response ID 且没有输出时，可以按普通重试策略重试。
- 已产生工具调用后，从持久化的 response output、child task ID 和函数输出继续。
- 无法证明可安全续跑时，将 round 标记为 `error`，保留已生成图片和检查点文本，不盲目重新执行工具调用。
- 现有 Agent 重新生成回复行为保留，但创建新的 round/job，不覆盖历史记录。

## 12. 图片存储设计

### 12.1 目录布局

历史无上限时不能把全部文件放在单一目录。使用图片 ID 前缀分片：

```text
/app/data/images/ab/cd/<image-id>.bin
/app/data/thumbnails/ab/cd/<image-id>.webp
/app/data/tmp/<job-id>-<random>.part
```

目录层级由服务端根据经过校验的图片 ID生成，客户端不能控制。

### 12.2 写入流程

1. 将上游响应流式写入临时文件，同时计算大小和 SHA-256。
2. 校验 MIME、文件大小和图片可解码性。
3. 使用 `sharp` 读取宽高。
4. `fsync` 后原子重命名到最终路径。
5. 在 PostgreSQL 事务中插入图片和任务引用。
6. 创建缩略图 job。

如果数据库提交失败，临时或最终孤立文件由审计清理；数据库中绝不写入尚未完成的文件路径。

### 12.3 读取流程

- 图片接口按图片 ID 查询 PostgreSQL，再映射到受控目录。
- 原图和缩略图接口均要求登录会话。
- 使用 `ETag`、`Content-Length`、正确 MIME 和 `Cache-Control: private, immutable`。
- 支持 Range 请求可作为实现阶段验证项，至少不能一次把大图完整读入 Node 内存。

### 12.4 去重

- 迁移时按现有图片 ID 去重并保留任务引用。
- 新图片继续生成稳定哈希 ID。
- `content_sha256` 用于完整性验证和重复诊断。
- 不因为缩略图版本变化创建新的原图记录。

## 13. REST API 设计

所有接口位于 `/api`，统一返回结构化错误码。写接口要求登录 Cookie、允许的 Origin 和 CSRF Token。

### 13.1 认证

- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/session`

登录成功后 Redis 保存会话，默认 TTL 30 天。Cookie 使用 HttpOnly、SameSite=Strict，在 HTTPS 下使用 Secure。

### 13.2 任务

- `POST /api/tasks`：创建画廊、编辑或批量任务，返回 `202` 和 queued task。
- `GET /api/tasks?page=1&pageSize=30`：分页列表。
- `GET /api/tasks/:id`：任务详情。
- `POST /api/tasks/:id/retry`：创建新任务，复用原任务输入和参数。
- `DELETE /api/tasks/:id`：仅允许终态任务。

列表参数：

- `q`
- `status=all|running|done|error`
- `favorite=true|false`
- `collectionId`
- `page`

为兼容现有筛选，`status=running` 同时匹配内部 `queued` 和 `running`；错误筛选继续匹配 `status=error` 或存在 `output_errors` 的任务。

### 13.3 图片

- `POST /api/images`：multipart 上传输入图或遮罩。
- `GET /api/images/:id`
- `GET /api/images/:id/thumbnail`

上传接口返回图片 ID、尺寸和缩略图状态。前端草稿只保存图片 ID。

### 13.4 API Profile

- `GET /api/profiles`：只返回脱敏元数据和 `hasApiKey`。
- `POST /api/profiles`
- `PUT /api/profiles/:id`
- `DELETE /api/profiles/:id`：软删除。

创建或修改时可提交 API Key；未提交新 Key 表示保留旧版本中的 Key。响应永不返回明文、密文、nonce 或 auth tag。

### 13.5 收藏夹

- `GET /api/favorite-collections`
- `POST /api/favorite-collections`
- `PUT /api/favorite-collections/:id`
- `DELETE /api/favorite-collections/:id`
- `PUT /api/tasks/:id/favorites`

批量收藏和删除沿用现有 UI 语义，服务端使用事务更新关系和任务列表修订号。

### 13.6 Agent

- `GET /api/agent/conversations`
- `GET /api/agent/conversations/:id`
- `POST /api/agent/conversations`
- `POST /api/agent/conversations/:id/rounds`
- `POST /api/agent/conversations/:id/rounds/:roundId/regenerate`
- `DELETE /api/agent/conversations/:id`

不提供停止或取消接口。

### 13.7 应用状态和迁移

- `GET /api/app-state`
- `PUT /api/app-state`
- `GET /api/migration/status`
- `POST /api/migration/browser/manifest`
- `POST /api/migration/browser/tasks`
- `POST /api/migration/browser/images`
- `POST /api/migration/browser/finalize`

迁移接口只在维护模式下启用。

## 14. SSE 实时事件

### 14.1 连接

- `GET /api/events`
- Cookie 鉴权。
- 每 15 秒发送 heartbeat。
- 客户端使用浏览器自动重连并带上 `Last-Event-ID`。

### 14.2 事件类型

- `task.created`
- `task.started`
- `task.progress`
- `task.completed`
- `task.failed`
- `thumbnail.ready`
- `agent.delta`
- `agent.round.updated`
- `favorite.updated`
- `sync.required`

每个事件包含全局事件序号、聚合 ID 和当前对象版本，不包含 API Key、完整上游请求头或图片二进制。

### 14.3 断线恢复

Redis Pub/Sub 不作为持久事件日志。API 比较客户端 `Last-Event-ID` 与当前序号：

- 无明显缺口时继续推送新事件。
- 发现缺口、API 重启或 Redis 重建时发送 `sync.required`。
- 前端重新请求当前页、打开的任务详情和活动 Agent 对话。

任务最终状态始终从 PostgreSQL 查询，不依赖 SSE 是否完整到达。

## 15. 分页、搜索与筛选

### 15.1 无筛选首页

1. 读取 PostgreSQL `task_list_revision`。
2. 比较 Redis `gip:tasks:revision`。
3. 修订号一致时优先读取第一页或第二页 JSON 缓存。
4. 缓存未命中时使用 `ZREVRANGE` 取得 30 个任务 ID。
5. 批量读取任务并按 ID 列表顺序组装。
6. 写入热点缓存。

### 15.2 搜索与复杂筛选

- 搜索覆盖提示词、参数和错误文本，语义为大小写不敏感的包含匹配。
- 使用 `pg_trgm` GIN 索引。
- 状态、收藏夹和搜索条件均作用于完整服务端数据集。
- 筛选改变时前端回到第 1 页。
- 搜索结果页可以使用条件哈希 + 列表修订号作为短期缓存键。

明确页码要求对深层筛选页使用 PostgreSQL `OFFSET`。这是单用户场景下可接受的初始方案；当数据量测量显示深页查询成为瓶颈时，再增加筛选结果游标映射，不在本次设计中提前构建复杂搜索索引服务。

### 15.3 前端展示

- 每页固定最多 30 个任务卡片。
- 卡片内展示该任务全部输出图。
- queued 状态显示“排队中”，running 显示现有运行态。
- 缩略图未完成时使用占位图，收到事件或后续读取成功后更新。
- 翻页时取消旧页面尚未完成的普通请求，但不影响服务端任务。
- URL 可以保存当前页和筛选条件，刷新后可恢复。

## 16. 前端状态改造

### 16.1 Zustand 职责收缩

`src/store.ts` 当前超过 5000 行，后端化后应只保留：

- 当前页任务和分页元数据。
- 当前筛选、选择和 UI 状态。
- 当前任务详情和 Agent 视图状态。
- 调用 API 的 action 入口。

需要移出的职责：

- 供应商 API 调用。
- 任务执行与恢复定时器。
- Agent Responses API 编排。
- 云快照合并和 tombstone 生成。
- 客户端缩略图生成。

拆分应沿现有业务边界渐进进行，不为减少行数机械创建小文件。

### 16.2 IndexedDB

IndexedDB 保留以下缓存：

- 最近访问任务 DTO。
- 原图和缩略图。
- 可选的当前页面快照。

缓存记录带服务端版本。网络恢复后以服务端为准覆盖，不再执行双向冲突合并，不再从 IndexedDB 删除推导服务端删除。

### 16.3 现有云同步退役

迁移完成后：

- 删除普通运行时对 `/cloud-api/snapshot` 的依赖。
- 删除客户端 `latestSnapshot`、tombstone、revision 冲突合并和全量 push。
- 保留旧接口只读迁移期兼容，核对完成后关闭。
- `cloudDataClearedAt` 不再作为新系统同步协议的一部分。

## 17. API Key 与安全设计

### 17.1 加密

- 使用 AES-256-GCM，加密 API Key、自定义鉴权请求头和其他供应商密钥字段。
- 主密钥来自 `CONFIG_ENCRYPTION_KEY` 环境变量。
- 每个 Profile 版本使用独立随机 nonce。
- 存储 `key_id`，为未来密钥轮换保留能力。
- 服务启动时校验密钥长度和格式，错误时拒绝启动。
- 解密只发生在 Worker 内存中，使用后不写日志或 Redis。

### 17.2 登录与会话

- 唯一访问密钥来自 `LOGIN_TOKEN` 环境变量。
- 登录比较使用恒定时间摘要比较。
- Redis 保存随机会话 token 的哈希，不保存明文 Cookie token。
- 默认 30 天 TTL，每次有效访问可按固定策略续期。
- 登录接口使用 Redis 限流，避免暴力尝试。

### 17.3 Web 安全

- HttpOnly、SameSite=Strict、HTTPS 下 Secure Cookie。
- 写接口校验 `Origin` 和 CSRF Token。
- Fastify schema 严格校验页码、字符串长度、图片 ID、Profile URL 和请求体大小。
- 图片路径只由服务端生成，防止路径穿越。
- 自定义供应商仅允许 HTTP/HTTPS，不允许 `file:` 等协议。
- 日志对 Authorization、Cookie、API Key、上游请求体和原始响应敏感字段脱敏。
- 图片和任务接口都要求登录，不把数据目录直接暴露为公共静态目录。

## 18. 旧数据迁移设计

### 18.1 迁移来源

1. 服务端 `sync.db` 中的完整快照。
2. 服务端 `cloud_images` 元数据。
3. 旧 `images/` 中的原图和缩略图。
4. 各浏览器 IndexedDB 中尚未同步的任务、图片、缩略图和 Agent 对话。
5. 旧持久化状态中的 API Profile、设置、收藏夹和草稿。

### 18.2 维护窗口

迁移期间：

- 禁止创建任务和修改数据。
- 旧 SQLite 和图片目录只读。
- 新 API 只开放登录、迁移状态和浏览器补充导入接口。
- 迁移前使用现有 `hasActiveDataOperations` 语义检查运行中任务和 Agent round；存在活动任务时拒绝开始。

### 18.3 命令

新增独立命令：

```text
npm run migrate:legacy -- --dry-run
npm run migrate:legacy -- --apply
npm run migrate:legacy -- --verify
```

命令必须幂等。重复执行同一来源时，通过 `legacy_import_items` 和内容摘要跳过已完成项，失败项可以单独重试。

### 18.4 服务端基线导入

1. 备份旧 `sync.db` 和图片目录。
2. 解析快照并运行现有 `normalize*` 逻辑。
3. 导入应用设置、收藏夹和 Profile；API Key 在写入 PostgreSQL 前立即加密。
4. 导入 Agent 对话、轮次和消息。
5. 导入任务和图片引用。
6. 校验图片文件是否存在、大小和 MIME 是否匹配。
7. 将文件复制到新分片目录，默认不移动或删除旧文件。
8. 导入任务时保留原 ID 和时间。

### 18.5 浏览器补充导入

新前端在维护模式下检测当前域名的旧 IndexedDB：

1. 先上传任务和图片 ID manifest。
2. 服务端返回缺失或可能冲突的 ID。
3. 浏览器分批上传任务元数据和缺失图片，避免一次构造巨型 JSON。
4. 多个浏览器可以依次重复执行。
5. 每个浏览器完成后显示本地数量、已存在数量、导入数量、冲突数量和失败数量。

### 18.6 冲突规则

任务按 ID 去重，比较时间顺序固定为：

1. `updatedAt`
2. `finishedAt`
3. `createdAt`

较新记录胜出。时间完全相同时，以已经导入的服务端基线为准并记录冲突报告。

图片按现有哈希 ID 去重。相同 ID 但文件摘要不同属于数据损坏，不自动覆盖，迁移失败并要求检查。

Agent 对话按 ID 和 `updatedAt` 合并；消息、round 和任务关联按稳定 ID 去重。

### 18.7 核对报告

正式切换前必须输出并保存：

- 任务总数及各状态数量。
- 图片元数据数量、原图数量、缩略图数量。
- 缺失文件、孤立文件和摘要冲突数量。
- Agent 对话、round、消息数量。
- API Profile 和收藏夹数量。
- 浏览器补充导入来源数量。
- PostgreSQL 外键与唯一约束检查结果。
- Redis ZSet 数量与 PostgreSQL 任务数量对比。

所有失败项为 0，或由用户明确接受并记录后，才能关闭维护模式。

### 18.8 切换与回滚

切换顺序：

1. 完成 dry-run。
2. 进入维护模式并备份。
3. 执行正式导入。
4. 执行浏览器补充导入。
5. 执行 verify。
6. 重建 Redis 队列、ZSet 和缓存。
7. 启动 API 与 Worker。
8. 手工检查分页、详情、图片、Profile 和一条测试任务。
9. 开放服务。
10. 停用旧同步写接口。

开放服务之前可直接回滚到只读旧系统。开放并产生新写入后，旧 SQLite 已不再是最新权威，不能简单回切；此时回滚必须恢复 PostgreSQL 与图片卷备份或提供反向导出，不允许悄悄恢复旧快照。

## 19. Docker 部署设计

### 19.1 Compose 服务

```text
gip-api
gip-worker
gip-postgres
gip-redis
```

持久化卷：

```text
gip-postgres-data
gip-redis-data
gip-image-data
```

PostgreSQL 和 Redis 默认不映射到宿主机，只在 Compose 网络中使用标准端口，因此不会与 Immich 冲突。确需调试时使用单独 profile 映射非默认宿主机端口，例如 PostgreSQL `55432`、Redis `56379`。应用端口使用独立可配置值，例如 `${APP_PORT:-3300}:3000`。

### 19.2 必要环境变量

- `LOGIN_TOKEN`
- `CONFIG_ENCRYPTION_KEY`
- `DATABASE_URL`
- `REDIS_URL`
- `IMAGE_DATA_DIR=/app/data`
- `APP_ORIGIN`
- `COOKIE_SECURE=true`
- `WORKER_CONCURRENCY=6`
- `JOB_LEASE_SECONDS`
- `JOB_RETRY_BASE_MS`
- `SESSION_TTL_SECONDS=2592000`
- `MAINTENANCE_MODE`

不在 Compose 文件中提供真实默认密钥。

### 19.3 健康检查

API：

- `/health/live`：进程存活。
- `/health/ready`：PostgreSQL、Redis 会话能力和图片目录可用。

Worker：

- 进程健康文件或内部 HTTP 健康端口。
- 检查数据库、Redis、租约续期和图片目录。

PostgreSQL 和 Redis 使用官方 healthcheck。API 在 migration 完成前不进入 ready。

## 20. 故障处理与恢复

| 故障 | 行为 |
|---|---|
| Redis 缓存丢失 | 列表和详情回退 PostgreSQL，后台重建 |
| Redis 队列丢失 | 从 PostgreSQL queued job 和过期 processing lease 重建 |
| Redis 完全不可用 | 已登录请求因会话不可用返回 503；数据库数据不丢失 |
| PostgreSQL 不可用 | API 拒绝写入，Worker 停止取得新任务，不依赖 Redis 猜测状态 |
| API 重启 | SSE 断线重连，客户端收到 `sync.required` 后补查 |
| Worker 重启 | processing lease 过期后重新入队 |
| 图片卷不可写 | job 按 I/O 错误重试，不提交图片元数据 |
| 缩略图失败 | 原图和任务保留，卡片显示占位图，缩略图 job 重试 |
| Outbox 重复发送 | Worker 和缓存消费者按事件/job ID 幂等 |
| 上游超时 | 按错误分类最多自动重试 2 次 |
| 上游鉴权失败 | 立即失败，不重试，不泄露响应中的密钥信息 |

## 21. 备份与恢复

### 21.1 必须备份的权威数据

- PostgreSQL 数据库。
- 图片持久化卷。
- `CONFIG_ENCRYPTION_KEY`，存放在数据库备份之外的安全位置。

没有加密主密钥时，Profile API Key 无法恢复。

### 21.2 Redis 备份

Redis 开启 AOF 和 RDB并备份其卷，但 Redis 备份不是业务恢复的必要条件。恢复 PostgreSQL 和图片后可以重建 Redis。

### 21.3 一致备份

提供备份命令进入短时备份锁：

1. 暂停文件清理 job。
2. 等待正在提交图片的数据库事务完成。
3. 执行 `pg_dump`。
4. 对图片卷做文件系统快照或增量同步。
5. 保存图片清单和摘要报告。
6. 解除备份锁。

恢复后先运行图片完整性审计，再重建 Redis，最后启动 Worker。

## 22. 测试设计

### 22.1 单元测试

- API schema、认证和 CSRF。
- Profile AES-GCM 加解密、脱敏和版本化。
- PostgreSQL repository 的状态条件更新。
- Outbox 幂等分发。
- job 错误分类、最大 3 次执行和指数退避。
- 任务租约续期和过期恢复。
- Redis ZSet 分页及同时间 ID 稳定排序。
- 修订号不一致时回退 PostgreSQL。
- 缓存键、TTL 和主动失效。
- 搜索、状态、收藏规则与现有前端规则一致。
- 图片路径生成和路径穿越防护。
- Agent 检查点、工具调用恢复和 child task 关联。
- 迁移时间冲突和图片 ID 冲突。

### 22.2 集成测试

使用隔离 PostgreSQL、Redis 和临时图片目录验证：

1. 创建任务后模拟 Redis 不可用，Outbox 恢复后任务仍入队。
2. Worker 在 processing 阶段退出，租约到期后任务重新执行。
3. Redis flush 后根据 PostgreSQL 重建任务 ZSet 和队列。
4. 连续提交 20 个任务时，同时 processing 不超过默认 6。
5. 429、5xx、超时重试两次，401 不重试。
6. 图片文件写入失败时数据库不出现可用图片记录。
7. 数据库提交失败时孤立文件能被审计发现和清理。
8. 首页第一页和第二页缓存命中，任务更新后旧缓存不可达。
9. SSE 断线后补查得到最终状态。
10. fal.ai 和自定义异步 task ID 在重启后继续轮询。
11. Agent 在工具调用边界重启后不重复创建 child task。
12. 删除任务后仅清理无引用图片。

### 22.3 迁移测试

- 使用当前 SQLite 快照和至少两个浏览器导出样本。
- 重复执行 `--apply` 不增加重复任务或图片。
- 较新浏览器任务覆盖旧云端任务。
- 同 ID 不同图片内容阻止切换。
- 缺失缩略图不阻止迁移，迁移后补建。
- 运行中任务阻止进入正式迁移。
- verify 报告数量与来源一致。

### 22.4 前端测试

- 每页固定 30 个任务。
- 页码、上一页、下一页及空页边界。
- 搜索或筛选变化回到第一页。
- queued、running、done、error 展示。
- 一张卡片展示多输出图。
- SSE 更新当前页，不把所有历史任务塞入 Zustand。
- IndexedDB 旧缓存不能覆盖服务端新版本。
- Profile 页面不显示或重新取得旧 API Key。
- 运行中任务删除按钮不可用。

### 22.5 验证命令

实现阶段至少实际运行：

```text
npm run build
npm test
npm run migrate:db
npm run migrate:legacy -- --dry-run
npm run migrate:legacy -- --verify
docker compose config
```

并在测试 Compose 环境运行 API、Worker、PostgreSQL 和 Redis 的集成测试。

## 23. 验收标准

### 23.1 正确性

- PostgreSQL、任务文件和前端显示之间无已知丢失记录。
- Redis flush 后系统能够自动或通过命令恢复队列与列表索引。
- Worker 强制退出后，过期任务可以恢复且不会永久停留在 processing。
- API Key 不出现在浏览器存储、网络响应、Redis 和普通日志中。
- 旧数据迁移数量核对通过，失败项明确为 0 或有书面接受记录。

### 23.2 功能

- 所有现有生成路径均通过后端执行。
- 峰值 20 个任务可提交，默认最多 6 个同时执行。
- 首页按任务每页 30 条，支持页码、上一页和下一页。
- 搜索、状态和收藏筛选覆盖完整历史。
- Agent 文本、任务状态和缩略图通过 SSE 渐进更新。
- 手动重试创建新任务；不支持取消。

### 23.3 性能参考

在同机 Docker、缓存预热且不包含图片二进制传输的条件下：

- 首页第一页和第二页缓存命中应在 100 ms 量级完成。
- 冷列表查询应在 500 ms 量级完成。
- 创建任务的数据库提交和返回不等待生成完成。
- Worker 状态提交后，SSE 通常在 1 秒内到达前端。

这些是验收目标，不替代实际硬件上的基准测试。若不满足，先通过查询计划、缓存命中率和文件 I/O 指标定位，不直接增加新基础设施。

## 24. 建议代码结构

```text
server/
  api/
    main.ts
    app.ts
    routes/
    plugins/
  worker/
    main.ts
    runners/
    providers/
  db/
    client.ts
    migrations/
    repositories/
  redis/
    client.ts
    keys.ts
    queue.ts
    cache.ts
    sessions.ts
    events.ts
  domain/
    tasks.ts
    jobs.ts
    profiles.ts
    agent.ts
  storage/
    imageFiles.ts
    thumbnails.ts
  legacy/
    migrateLegacy.ts
    verifyLegacy.ts
shared/
  apiTypes.ts
  taskTypes.ts
  profileTypes.ts
```

目录仅按真实职责拆分。简单 repository 和 handler 不再增加额外 service 包装；供应商适配器复用并迁移现有实现，不复制浏览器版本。

## 25. 分阶段落地

### 阶段 1：基础设施与只读 API

- Fastify TypeScript 构建。
- PostgreSQL migration runner。
- Redis 客户端、会话和健康检查。
- 图片目录模块。
- PostgreSQL 只读任务分页和 Profile 脱敏接口。

### 阶段 2：任务队列与普通生图

- jobs、outbox、pending/processing、租约和重试。
- 迁移 OpenAI、fal.ai 和自定义供应商执行逻辑。
- 原图和缩略图 Worker。
- REST 创建任务和 SSE 状态事件。

### 阶段 3：前端分页与服务端权威

- TaskGrid 改为服务端分页，每页 30 条。
- IndexedDB 改为只读缓存语义。
- Profile 与收藏 CRUD 改为 REST。
- 停止新客户端写旧云快照。

### 阶段 4：Agent 后端化

- Agent round job、文本 SSE、工具调用持久化。
- child generation task 和继续轮次恢复。
- Agent 对话 API 和前端改造。

### 阶段 5：迁移工具与正式切换

- SQLite dry-run、apply、verify。
- 浏览器 IndexedDB 补充导入。
- Redis 重建和数量核对。
- 维护窗口切换与旧同步接口停用。

每个阶段必须保持可测试，不在一个提交中同时重写整个前端 store 和所有后端逻辑。

## 26. 兼容性风险与限制

### 26.1 静态部署不再完整可用

Vercel 静态站点、GitHub Pages 和纯 Cloudflare 静态部署无法运行新的任务系统。新的正式部署入口是包含 API、Worker、PostgreSQL、Redis 和图片卷的 Docker Compose。若继续发布静态站，只能作为无法生图的界面预览，不能作为完整产品。

### 26.2 上游重复调用

对不支持幂等键的同步供应商，Worker 在极小故障窗口内可能重复调用。该风险必须在运维文档中明确，不得声称绝对 exactly-once。

### 26.3 共享文件卷限制

API 与 Worker 必须能访问同一图片卷。当前设计适合同一 Docker 主机；未来跨主机横向扩展时需要共享文件系统或对象存储，这不在本次范围内。

### 26.4 深层筛选分页

普通首页通过 ZSet 支持快速任意页。搜索和复杂筛选初期使用 PostgreSQL OFFSET，极深页可能变慢。先通过实际查询计划和数据规模验证，再决定是否引入筛选游标缓存。

### 26.5 迁移中的明文历史密钥

旧 SQLite 快照或浏览器持久化数据可能包含明文 API Key。迁移工具不得在报告和日志中输出这些字段；迁移完成后应限制旧备份权限，并在确认回滚窗口结束后安全归档或删除。

## 27. 最终结论

该设计使用 PostgreSQL 承担权威数据和事务一致性，Redis 承担可恢复的队列、ZSet 分页、热点缓存、会话和实时事件，服务端目录承担大文件存储。它保留现有业务语义，同时移除浏览器直接执行、完整快照双向合并和全量任务渲染三个主要扩展瓶颈。

实现时最重要的顺序是：先建立 PostgreSQL 数据模型和 Outbox，再迁移普通生成任务，随后改造前端分页与缓存，最后迁移 Agent 和执行正式数据切换。不能先删除旧同步或直接把 Redis 当作权威数据源。
