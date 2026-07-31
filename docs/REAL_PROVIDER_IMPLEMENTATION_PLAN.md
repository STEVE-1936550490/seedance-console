# 真实 Seedance Provider 分阶段实施计划

## 1. 执行原则

本文用于后续 P3/P4，不在 P2 执行。

- 每阶段保持 Mock Provider 可运行、可测试，默认配置始终为 `mock`。
- 每阶段只引入一个可独立验证的增量。
- 所有 Provider 响应使用 Zod 或 Bridge 侧等价 schema 加 TypeScript Zod 双层校验。
- 自动化测试只使用 fixture、fake transport 和 Mock Provider，不调用收费接口。
- `REAL_API_TEST` 默认 `false`；即使设为 true，也必须获得用户对当次收费调用的明确授权。
- 创建任务不做通用自动重试；查询和下载才允许受控退避。
- 未确认字段保持不实现，不用常见视频 API 经验补齐。
- 不删除或改写已经验收的 Mock 行为。

每个阶段完成后执行与改动相称的检查；最终阶段前统一执行：

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
docker compose config --quiet
```

## 2. P3 开始前的设计门

开始写真实 transport 前确认以下工程选择：

1. 应用 Provider 值固定为 `mock | seedance`。
2. 基于当前协议证据，首个真实 transport 选择私有 Python Bridge；Direct TypeScript transport 保持禁用，除非已有完整 AICC 兼容依据。
3. 明确 SDK wheel 的私有制品来源、校验值、镜像使用授权和日志关闭/过滤方案。
4. 选择本地 Asset 的 Provider 可达 URL 策略：
   - 已有对象存储签名 URL；或
   - Console 短期签名 HTTPS 素材端点。
5. 明确 Provider 真实运行配置只从部署环境注入，不进入仓库。

如果第 3 或第 4 项未满足，可以完成接口、映射、fixture、状态机和 fake Bridge 测试，但不能宣称真实图生视频 Provider 已可部署。

## 3. 阶段 1：配置和类型扩展

### 范围

- 将 Provider 类型从 Mock literal 泛化为 `mock | seedance`。
- 拆分 `ProviderDefinition` 与 `ProviderRuntime`。
- 增加 `validateParameters()`、`createTask()`、`getTask()`、`cancelTask()`、`normalizeStatus()`、`normalizeUsage()`、`downloadOutput()` 目标契约。
- 让 Mock Provider 实现新契约；Mock `downloadOutput()` 封装现有 fixture。
- 新增 Provider factory：
  - API 创建无 secret definition。
  - Worker 创建 runtime。
- 配置 schema 增加 `SEEDANCE_PROVIDER` 和条件校验；默认 `mock`。
- 将当前 `SEEDANCE_PROVIDER_DRIVER` 标记为迁移项，避免同时存在两个冲突来源。

### 预计文件

- `packages/seedance-provider/src/types.ts`
- `packages/seedance-provider/src/mock-provider.ts`
- `packages/seedance-provider/src/provider-factory.ts`
- `packages/config/src/index.ts`
- `.env.example`
- API/Worker bootstrap

### 验证

- Mock capabilities、创建、查询、取消、用量和下载契约测试全部通过。
- `mock` 模式不要求任何真实 Provider 变量。
- `seedance` 缺必填配置时启动失败，不回退到 Mock。
- API 进程环境不需要 `SEEDANCE_API_KEY`。

## 4. 阶段 2：Provider Bridge 契约与客户端

### 范围

- 定义 Bridge OpenAPI/JSON schema：
  - health live/ready
  - create
  - query
  - cancel unsupported
  - output stream
- 实现 TypeScript `SeedanceBridgeClient`，所有 JSON 用 Zod 校验。
- 使用内部 bearer token；日志 serializer 删除 token、URL 和 body。
- 首先实现 fake Bridge 测试服务器，不接 SDK、不访问网络。
- 在 SDK 制品和日志条件满足后，再搭建 `services/provider-bridge`：
  - 固定 wheel SHA-256。
  - 使用非 root 用户。
  - 只监听 Compose 内部网络。
  - readiness 不发起生成或其他收费调用。
  - RSA key 与提交注册表使用持久化目录。
- Direct HTTP transport 以明确 `UNSUPPORTED_TRANSPORT` 启动失败，不发送明文请求。

### 验证

- fake Bridge 覆盖 2xx、429、5xx、超时、无效 JSON、schema 不符和连接中断。
- Bridge token 不出现在日志快照。
- Bridge 未发布宿主机端口。
- health check 不调用 Provider。

## 5. 阶段 3：创建任务映射

### 范围

- 实现 `SeedanceParameters` 的结构校验。
- 初始只启用 `docs/provider-api.md` 已确认字段和值。
- 按字段映射构造 `content`、`generate_audio`、`ratio`、`duration`、`watermark`。
- 模型 ID 来自环境；不硬编码 demo 值。
- `clientRequestId` 只作为本地/Bridge 提交键，不发送未知远端字段。
- create 响应只接受非空 provider task ID。
- 所有 create 超时、断连和空 ID 进入 outcome unknown，不自动重发。

### 验证

- fixture 精确断言请求映射。
- Mock 专用字段不会出现在真实请求。
- prompt、素材 URL 和 Authorization 不出现在日志。
- create transport 失败不会触发第二次 create 调用。

## 6. 阶段 4：持久化 `providerTaskId`

### 范围

- 把 submit 与 poll processor 分离。
- 新增 `ProviderSubmission` 迁移和必要索引。
- `QUEUED → SUBMITTING` 使用条件更新抢占唯一提交权。
- create 成功后事务写入：
  - `providerTaskId`
  - `submittedAt`
  - `PROCESSING`
  - `PROVIDER_ACCEPTED` event
- 同一任务的 `provider + providerTaskId` 保持唯一。
- Bridge 注册 `clientRequestId → providerTaskId`，支持 Worker 在数据库恢复后补写。
- `SUBMITTING + providerTaskId=null` 禁止重新提交，进入协调流程。

### 验证

- 两个并发 submit job 只有一个调用 Provider。
- 数据库暂时失败后，Worker 使用已经获得的 ID 重试写库，不再次 create。
- Worker 重启后可以从 fake Bridge 注册表恢复 ID。
- 注册表也无映射时保持 `SUBMITTING/OUTCOME_UNKNOWN`，不产生第二个收费任务。

## 7. 阶段 5：可恢复轮询

实现说明见 [Provider 版本化轮询实现](POLLING_SCHEDULING.md)。当前采用
`pollVersion + pollLeaseUntil` 作为每轮查询的乐观版本和执行租约；PostgreSQL
保存调度事实，BullMQ 只负责投递。

### 范围

- Prisma 增加 poll 调度字段和索引。
- 实现 versioned delayed poll job。
- 实现协调器扫描到期 `PROCESSING` 任务并补偿丢失 job。
- 成功处理中响应按基础间隔继续。
- 连续 transient/429 使用指数退避、有界抖动和最大间隔。
- 正常响应后清零连续 transient 计数。
- 达到最大轮询时长时记录明确本地过期原因，不创建新任务。
- 未知 Provider 状态保持当前状态并告警。

### 验证

- `pending`、`queued`、`running` 均保持内部 `PROCESSING`。
- 重复/旧版本 poll job 无副作用。
- Redis job 丢失后协调器可恢复。
- Worker 重启后从 PostgreSQL 的 `nextPollAt` 恢复。
- fake clock 验证退避、抖动边界和最大时长，测试不 sleep。

## 8. 阶段 6：视频下载和本地持久化

实现说明见 [Provider 输出下载与恢复](DOWNLOAD_SAFETY.md)。当前 Worker/Storage
闭环已使用 Mock fixture 实现；真实 Python Bridge 和 SDK 下载/解密仍未启用。

### 范围

- Provider `succeeded` 只安排 download job，不直接写内部 `SUCCEEDED`。
- 实现 `downloadOutput(providerTaskId)`：
  - Bridge 调用 SDK 下载/解密。
  - URL 不离开 Adapter。
- Storage 增加临时写和原子提交能力。
- 使用确定性最终 key。
- Worker 不接收 URL；Bridge 是唯一配置目标。未来 direct URL transport 启用前
  必须补齐 HTTPS、host/IP 和重定向 SSRF 校验。
- 校验响应元数据、MIME、大小、SHA-256 和 MP4 容器结构。
- 成功后事务创建 Asset/TaskAsset/VideoOutput 并进入 `SUCCEEDED`。
- 当前真实 `normalizeUsage()` 返回空数组。

### 验证

- 正确 MP4 保存并可由现有 API 播放/下载。
- 错误 MIME、超大文件、截断流、错误签名全部清理临时文件。
- 文件成功但数据库提交失败后可从确定性 key 恢复，不重新下载或创建任务。
- Provider URL 和签名参数不进入数据库、job 或日志。

## 9. 阶段 7：取消任务

### 范围

- 修正 API 取消语义：
  - `QUEUED` 可本地取消。
  - `SUBMITTING/PROCESSING` 不再直接写 `CANCELLED`。
- Seedance capabilities 初始 `supportsCancellation=false`。
- `cancelTask()` 初始返回 `ProviderUnsupportedOperationError`。
- 为未来确认的远端取消预留 cancel job、请求时间和条件更新。
- 只有 Provider 明确确认取消后才进入内部 `CANCELLED`。

### 验证

- 排队任务取消后 submit job 无操作。
- 处理中任务不会被假取消。
- 成功与取消竞态不能把 `SUCCEEDED` 改成 `CANCELLED`。
- Mock 取消行为继续通过现有验收。

## 10. 阶段 8：fixture 单元与集成测试

### 范围

- 固化 `docs/PROVIDER_FIELD_MAPPING.md` 列出的全部 fixture。
- 建立同一套 Provider contract tests：
  - Mock runtime
  - Seedance fake Bridge runtime
- 增加任务 processor 集成测试：
  - submit/poll/download 分离
  - outcome unknown
  - 服务器重启恢复
  - Redis 丢 job 恢复
  - 本地文件已存在恢复
- 检查客户端 secret 扫描覆盖新增配置名。

### 验证

```bash
pnpm test
pnpm typecheck
pnpm check:client-secrets
```

测试过程中网络只连接本地 fake server；增加断言确保没有访问真实 Base URL。

## 11. 阶段 9：Docker 集成

### 范围

- 若选择 Bridge，新增私有 Bridge image/service。
- API 不接收 Provider Key；Worker 只接收 Bridge URL/token；Bridge 独占真实 Key 和 RSA 私钥。
- Bridge 不配置 `ports`，只在内部网络被 Worker 访问。
- 新增 Bridge 持久化卷和 healthcheck。
- Compose 仍默认 `SEEDANCE_PROVIDER=mock`，Mock 路径不启动或不依赖 Bridge。
- seedance profile/override 缺 secrets 时 fail closed。
- 更新部署文档，但不提交真实 `.env`。

### 验证

```bash
docker compose config --quiet
docker compose up -d --build --wait
docker compose ps --all
```

- Mock E2E 回归全部通过。
- fake Bridge Docker 集成通过。
- Compose 渲染结果不包含真实 Key。
- Web 镜像、页面源码和网络响应不含 Provider secrets。

## 12. 阶段 10：显式开启的真实 API 最小联调

本阶段属于 P4，只有用户对当次收费调用明确确认后才能执行。

双重门：

```text
用户明确授权当次调用
AND
REAL_API_TEST=true
```

任一不满足都必须跳过。测试规则：

1. 只创建一个最低成本短视频。
2. 使用非敏感测试提示词和素材。
3. 在 create 返回结果未知时立即停止，不重复提交。
4. 记录内部 task ID、脱敏 providerTaskId、时间、状态序列、总耗时、输出规格、Provider 明确返回的用量/费用和 URL 有效期。
5. 不记录 Authorization、Key、素材 URL、完整视频 URL 或 SDK 原始响应。
6. 验证视频已保存本地后再判断任务成功。
7. 联调完成后关闭 `REAL_API_TEST`。

## 13. 阶段依赖关系

```text
1 配置和类型
  ↓
2 Bridge/transport client
  ↓
3 创建映射
  ↓
4 providerTaskId 持久化
  ↓
5 可恢复轮询
  ↓
6 下载和持久化
  ↓
7 取消语义
  ↓
8 fixture/集成测试
  ↓
9 Docker 集成
  ↓ 用户明确授权
10 真实最小联调
```

阶段 7 可以在远端取消仍未确认时完成“不支持”的安全实现，不阻塞阶段 8/9。阶段 10 不能反向成为前面阶段测试的依赖。

## 14. 完成定义

P3 完成需同时满足：

- Mock Provider 默认运行并通过原有 E2E。
- seedance Adapter 所有字段来自 `docs/provider-api.md`。
- Provider 原始字段不泄露到 API/Web。
- create 无通用自动重试，outcome unknown 可审计。
- providerTaskId、poll 和输出下载均可跨 Worker 重启恢复。
- Provider URL 过期前输出已保存到本地 Storage。
- fixture 测试不调用收费接口。
- lint、typecheck、test、build 和 Compose config 全部通过。
- 未执行真实视频生成。
