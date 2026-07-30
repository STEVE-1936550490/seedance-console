# 实施计划

## 原则

每阶段只引入一个可验证增量，完成后必须能独立启动并通过明确检查。真实 Provider 接入不阻塞 MVP；在 `docs/provider-api.md` 的待确认项补齐前不扩展或猜测 Seedance 请求字段。

## 阶段 0：设计基线（本轮）

**交付**：PRD、架构、状态机、Provider 契约、贡献指南与本计划。

**验证**：文档之间的状态名、组件职责、目录和实体一致；不存在虚构 Seedance 参数；不安装依赖、不生成业务代码。

## 阶段 1：工作区骨架与 Mock Provider

**交付**：

- 初始化 pnpm workspace、TypeScript strict、lint、format 和测试配置。
- 创建 `apps/web`、`apps/api`、`apps/worker` 及核心 packages 的最小入口。
- 首先实现 `SeedanceProvider` 契约与 `MockSeedanceProvider`，包含成功、失败、慢处理和幂等场景。
- Docker Compose 启动 PostgreSQL 与 Redis；各进程提供最小健康检查。

**独立验证**：`pnpm lint && pnpm typecheck && pnpm test && pnpm build` 通过；Compose 依赖健康；Mock Provider 契约测试不访问网络。此阶段不创建完整业务页面或真实 Provider。

## 阶段 2：数据库、存储与上传

**交付**：

- Prisma 落地 `VideoTask`、`Asset`、`TaskAsset`、`TaskEvent`、`UsageRecord` 及首个 migration。
- 本地 `Storage` 实现，防路径穿越，支持流式读写、校验和与删除。
- Fastify 图片上传接口，实施 MIME、扩展名和配置化大小限制。

**独立验证**：全新数据库可迁移；上传合法 fixture 后可按 Asset ID 读取；非法类型、超限和路径穿越测试被拒绝；重启后文件和元数据仍存在。

## 阶段 3：异步任务闭环

**交付**：

- 任务创建、单项查询 API 与共享 Zod DTO。
- BullMQ 入队、Worker 执行、延迟轮询和状态事务。
- Mock 成功后保存视频 Asset 与用量；失败后保存内部错误与 TaskEvent。
- 确定性 Job ID、条件状态更新、重复消费无害化和缺失 Job 补偿。

**独立验证**：通过 API 创建三种 Mock 场景；观察完整状态流；重启 Worker 后恢复；重复请求/Job 不重复创建 Provider 任务；成功文件可流式下载。

## 阶段 4：MVP Web 控制台

**交付**：

- 创建页：提示词、参考图片、由能力接口驱动的 Mock 参数表单。
- 详情页：状态、可用进度、失败原因、输入摘要、视频预览和下载。
- 历史页：倒序分页与状态筛选；终态停止轮询，非终态采用退避。
- 使用原创、简洁的内部工具视觉语言。

**独立验证**：仅通过浏览器完成上传、创建、轮询、失败展示、历史、预览和下载；浏览器请求及构建产物中无 Provider 密钥。

## 阶段 5：可靠性、安全与运维

**交付**：

- 请求限流、结构化脱敏日志、关联 ID、优雅停机和健康/就绪检查。
- 上传/输出保留策略、孤立文件清理、数据库备份与恢复说明。
- Docker Compose Linux 部署配置、`.env.example`（仅变量名和安全说明）。
- API 集成测试及关键恢复场景测试。

**独立验证**：执行安全测试与故障演练（Redis/Worker 重启、Provider 超时、重复 Job）；按部署文档在干净 Linux 环境启动；备份恢复抽查通过。

## 阶段 6：真实 Seedance 2.0 适配（等待文档）

**前置条件**：`docs/provider-api.md` 第 11 节的关键协议项已补齐，且第 1–5 阶段的 Mock 闭环稳定。

**交付**：

- 建立仅内网可见的 Python Provider Bridge，固定安装已审核的本地 SDK wheel，并由 TypeScript `Seedance2Provider` 调用。
- 将已确认字段转换为严格请求/响应 schema，实现 SDK transport；保留 `direct-http` transport 插槽。
- 完成状态、错误、输出、取消和用量映射；只采用文档允许的重试与幂等策略。
- 通过配置选择 `mock`、`maas-sdk` 或 `direct-http`，默认开发环境仍使用 Mock；原生 HTTP 仅在机密协议获得官方确认后启用。

**独立验证**：先通过脱敏 fixture、Bridge 健康检查和跨语言契约测试，再在明确授权的测试凭据/环境执行最小烟测；真实调用必须由人工显式开启，不进入普通测试。

## 阶段完成定义

每阶段须同时满足：范围内实现完成、lint/typecheck/test/build 通过、启动步骤可重复、无高优先级已知缺陷、配置和行为文档已更新。未达到时不开始叠加下一阶段业务。
