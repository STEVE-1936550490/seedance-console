# 真实 Provider Demo 最终检查点

记录时间：2026-07-31，2026-08-02 完成图生视频状态对账（Asia/Shanghai）

## 1. 最终结论

真实收费 Seedance Demo 已分别完成一次纯文生视频、一次单参考图图生视频和一次单参考
视频的视频生视频。修正
Provider Base URL 后，真实 create 成功返回 providerTaskId，随后完整通过：

```text
create → provider accepted → versioned poll → SDK download/decrypt
       → MP4 validation → local persistence → Web playback/download
```

不得再次创建新的真实收费任务。任何后续真实 create 都需要新的用户明确授权；不得
重新提交本文记录过的任何 `clientRequestId`。

## 2. 首次成功的纯文真实任务

- 本地 taskId：`cms9135ya0002s501mt1ua2jk`
- clientRequestId：`real-demo-20260731-2222-73f6ac19`
- providerTaskId：`cgt-20260731221858-8z7zj`
- Provider：Seedance / AICC Python Bridge
- 模型：`doubao-seedance-2.0`
- 最终状态：`SUCCEEDED`
- 创建时间：2026-07-31 22:18:58（Asia/Shanghai）
- Provider 接受时间：2026-07-31 22:18:59（Asia/Shanghai）
- 本地完成时间：2026-07-31 22:21:57（Asia/Shanghai）
- 总耗时：约 3 分钟
- 参数：
  - `duration=11`
  - `ratio=16:9`
  - `generate_audio=false`
  - `watermark=false`
  - 仅文本输入，无图片、视频或音频素材
- 输出：`video/mp4`，5,329,931 字节
- 数据库 storageKey：`outputs/cms9135ya0002s501mt1ua2jk/video.mp4`
- 容器内路径：
  `/data/storage/outputs/cms9135ya0002s501mt1ua2jk/video.mp4`
- 本地播放端点：HTTP 200，`video/mp4`
- Web 播放：通过
- Web/API 下载：通过
- Provider 用量与实际费用：未返回，不得估算

成功状态时间线：

| 时间（UTC）             | 状态/事件                        |
| ----------------------- | -------------------------------- |
| 2026-07-31 14:18:58.403 | `QUEUED / TASK_CREATED`          |
| 2026-07-31 14:18:59.031 | `PROCESSING / PROVIDER_ACCEPTED` |
| 2026-07-31 14:21:57.039 | `SUCCEEDED / OUTPUT_PERSISTED`   |
| 2026-07-31 14:21:59     | 播放端点复验 `200 / video/mp4`   |

### 2.1 成功的单参考图真实任务

该任务在此前获得的单次授权下完成；2026-08-02 的状态对账没有重新调用 Provider：

- 本地 taskId：`cms9w5wu70006lj019o2gbni8`
- clientRequestId：`eos-real-image-20260801-003`
- providerTaskId：`cgt-20260801124854-j8sp2`
- Provider / 模型：Seedance / `doubao-seedance-2.0`
- 输入：单张 JPEG，93,243 字节，经私有 EOS 预签名 URL 发布
- 参数：`duration=11`、`ratio=16:9`、`generate_audio=false`、`watermark=false`
- Provider 状态：`running → succeeded`
- 本地状态：`SUCCEEDED / OUTPUT_STORED`
- 输出：`video/mp4`，7,309,809 字节
- 数据库和本地文件 SHA-256：
  `6ea9470b628cf49913b647f7431fa86594bef2f3719482ea25e7f16ddce1f7eb`
- storageKey：`outputs/cms9w5wu70006lj019o2gbni8/video.mp4`
- EOS 临时对象前缀：`seedance-inputs/3c567b17…`
- EOS 清理：数据库 `deletedAt` 已记录、`cleanupError` 为空；验收时 `HeadObject`
  返回 404
- 泄漏检查：数据库、Redis、前端响应和容器日志均未命中预签名 URL 或凭证模式

状态时间线：

| 时间（UTC）             | 状态/事件                            |
| ----------------------- | ------------------------------------ |
| 2026-08-01 04:48:54.655 | `QUEUED / TASK_CREATED`              |
| 2026-08-01 04:48:57.759 | `PROCESSING / PROVIDER_ACCEPTED`     |
| 2026-08-01 04:55:56.816 | `PROCESSING / PROVIDER_OUTPUT_READY` |
| 2026-08-01 04:55:58.012 | `SUCCEEDED / OUTPUT_STORED`          |

### 2.2 成功的单参考视频真实任务

- 本地 taskId：`cmsbwzh9w0000o90144jhj1q3`
- clientRequestId：`aicc-v2v-20260802-single-002`
- providerTaskId：`cgt-20260802225037-zzn8z`
- Provider / 模型：Seedance / `doubao-seedance-2.0`
- 输入：既有图生视频成功产出的 MP4，经私有 EOS 临时发布
- 参数：`duration=11`、`ratio=16:9`、`generate_audio=false`、`watermark=false`
- 本次有效真实 create 次数：**1**，没有自动重试或第二次 create
- Provider 状态：`accepted → running → succeeded`
- 本地最终状态：`SUCCEEDED / OUTPUT_STORED`
- 输出：`video/mp4`，6,254,602 字节
- SHA-256：
  `9636a5981ee542180ce24e7783931baff607a87d5c23ca93ea4a8d9819c5bf38`
- storageKey：`outputs/cmsbwzh9w0000o90144jhj1q3/video.mp4`
- 播放和下载 API：HTTP 200，Content-Type、Content-Length 和 SHA-256 一致
- EOS 临时对象：已删除，`HeadObject` 返回 404
- 泄漏检查：数据库、Redis/队列、API、Web、容器日志及 Git 跟踪文件命中数均为 0

同日较早的本地任务 `cmsbtqe7e0000o90145yn238v` 曾进入
`PROVIDER_CREATE_OUTCOME_UNKNOWN`。远端任务列表在调用窗口内无匹配，用户人工确认该
窗口无扣费且最近扣费仍为此前图生视频任务，因此保留原始事件并追加
`USER_CONFIRMED_NO_BILLING`，最终按 `PROVIDER_TASK_NOT_CREATED` 完成人工对账；该任务
没有被重试。

## 3. Create 次数口径

纯文 Demo 的有效真实 create 次数为 **1**，即成功任务
`cgt-20260731221858-8z7zj`。后续图生视频验收另有一次确认成功的 create，即
`cgt-20260801124854-j8sp2`。单参考视频验收另有一次确认成功的 create，即
`cgt-20260802225037-zzn8z`。三者均不得重复创建。

在成功前曾有请求因部署配置中的 `AICC_BASE_URL` 缺少 `/api/v3` 而命中错误路径：

- SDK 模型映射请求返回 HTTP 404；
- 创建请求也返回 HTTP 404，且没有 providerTaskId；
- 请求没有到达本文确认的 `/api/v3/contents/generations/tasks` 创建端点；
- 系统没有自动重发；迁移后相关本地任务进入
  `RECONCILIATION_REQUIRED / OUTCOME_UNKNOWN`。

这些错误路径 HTTP 请求只作为历史诊断记录，不计入有效真实 Provider create 次数，
也不得被重新提交。根因修复结论是：

```dotenv
AICC_BASE_URL=https://<provider-host>/api/v3
```

Base URL 必须包含 `/api/v3`。模型映射复验返回 HTTP 200 且 endpoint 有效后，才执行
了上文唯一一次有效真实 create。

## 4. 当前安全运行状态

- API、Worker、Provider Bridge 均为 healthy。
- 系统已恢复默认 `SEEDANCE_PROVIDER=mock`。
- `REAL_API_TEST=false`。
- Bridge create 门在关闭状态下复验返回
  `403 / REAL_API_TEST_DISABLED`，请求在访问 Provider 前被拒绝。
- Bridge 不发布宿主机或公网端口。
- Provider 取消能力仍为 false，不伪造远端取消成功。
- Provider 凭据仅保留在 `/etc/seedance-console/provider.env`，不在 Git 中。
- 不存在仍在运行的临时真实模式 override。

## 5. 已实现闭环

真实 AICC 路径已实现并经成功任务验证：

- TypeScript Seedance Provider definition/runtime 与参数校验；
- 私有 Python AICC Bridge、内部 bearer token 和固定 SDK wheel 校验；
- Bridge RSA key 与 SQLite submission registry 持久化；
- create 防重复提交和 outcome-unknown 人工协调边界；
- 脱敏创建诊断：HTTP 状态、稳定分类、受限业务码和关联 ID；
- providerTaskId 事务持久化；
- PostgreSQL 为事实源的版本化 poll、租约、退避与丢 job 补偿；
- Bridge 通过 SDK 查询、下载和解密输出；
- Worker 对 MIME、大小、SHA-256 和 MP4 容器进行校验；
- 确定性 storageKey、临时文件清理、原子落盘和数据库恢复；
- API/Web 播放与下载。

## 6. SDK、日志与敏感信息

- 外层制品：`pythonSDK-0515.zip`
  - SHA-256：
    `e718a80945c6885172aaf17826ca9fd362d0ba0d805d42ea07242f020a6cece9`
- wheel：`maas_seedance_sdk==1.0.0`
  - SHA-256：
    `36f86be4d97400c1964eba0a0f9b845e047e8430499ae42990cb98cb9d961039`
- wheel 内 vendored AICC SDK：`0.0.21`
- Bridge 基础镜像：Python 3.12 slim，非 root 用户。
- Bridge 构建时校验 wheel SHA-256 后才安装。

验收中曾发现 SDK 把 API Key 写入私有 Docker volume 的 `jsc_log/jsc.log`。该文件
未进入 Git 或容器标准日志，已精确删除。Bridge 已在 SDK 导入后移除全部 Loguru
sink 并阻止 SDK 再次添加 sink；修复后 SDK 日志残留为 0 字节，仓库和当前容器
日志中的实际 API Key/Bridge Token 匹配均为 0。若安全政策要求，仍应轮换曾落盘
过的 AICC API Key。

## 7. 已完成验证

- Python Bridge tests：22/22，包含旧注册表原位升级、审计时间保留与 SDK 视频 Header 审计。
- TypeScript tests：18 个测试文件、161/161。
- `pnpm lint`：通过。
- `pnpm typecheck`：通过。
- `pnpm build`：通过。
- 客户端密钥扫描：通过。
- Prisma validate、migrate status、migrate deploy：通过，10 个 migration 已应用；审计时间
  列为 `TIMESTAMPTZ(3)`，UTC/+08:00 与 DST 偏移往返结果一致。
- `docker compose config --quiet`：通过。
- PostgreSQL、Redis、API、Worker、Provider Bridge：healthy。
- 纯文和单参考图真实任务的 create、poll、download、本地持久化、Web 播放与下载：通过。
- Mock 模式恢复：通过。
- 真实 create 关闭门：`403 / REAL_API_TEST_DISABLED`。

## 7.1 视频生视频验收暴露缺陷及收口

Bridge 成功响应审计时间为带明确 UTC 偏移的
`2026-08-02T14:50:34.783+00:00`。旧 TypeScript schema 未允许偏移格式，导致在已经
取得 providerTaskId 后抛出本地 `PROVIDER_PROTOCOL_ERROR`；提交异常分支误把该错误当作
确认未创建并提前删除 EOS 对象。远端任务实际继续运行并最终成功，本地通过 Bridge
submission registry 找回 providerTaskId 后恢复 poll 和下载。

修复后：

- Bridge 审计时间以 ISO 8601 UTC `Z` 输出；接口同时接受 `Z` 或明确偏移并立即规范化为
  UTC `Z`，拒绝无时区或模糊格式；
- ProviderSubmission 审计时间迁移为 PostgreSQL `TIMESTAMPTZ(3)`；展示层才转换本地时区；
- 成功响应解析失败按 outcome unknown 处理并只读恢复，不再当作确认未创建；
- `providerAssetCleanupReadyAt` 是 EOS 删除的持久化门禁；只有确认未创建、远端明确失败/
  取消/过期，或成功输出完成下载、持久化及校验后才能设置；
- 本地 poll 超时转入 `RECONCILIATION_REQUIRED`，不会触发 EOS 清理；
- DeleteObject 和数据库 deletedAt 更新保持幂等，清理失败只记录清理错误，不覆盖任务终态。

## 8. 当前限制与后续 TODO

- 不再执行真实收费 create；如未来确需执行，必须获得新的明确授权。
- 真实 Demo 已验收纯文生视频、单张 JPEG 图生视频和单段 MP4 视频生视频；图片/视频的
  fixture E2E、私有 EOS 上传/GET/删除和真实 Provider 拉取均已完成验收。图片和视频的正式
  租户限制与最短 TTL 仍待确认。见 [Provider 素材安全发布](ASSET_PUBLISHING.md) 和
  [单参考视频 MVP](REFERENCE_VIDEO_MVP.md)。
- Provider 远端取消语义仍未确认，当前明确报告不支持。
- Provider 未返回用量、Token 或费用字段，继续保持空用量，不做推测。
- Provider 正式错误码、限流规则、输出 URL TTL 和远端幂等能力仍待官方确认。
- Direct TypeScript transport 仍禁用；AICC 真实路径继续使用私有 Python Bridge。
- 对象存储/MinIO/S3、复杂 RBAC、多租户、支付不属于当前 MVP。

## 9. 证据保留

继续工作时不得删除成功任务、输入素材、生成视频或历史 outcome-unknown 任务，也不得
重新提交已记录的 `clientRequestId`。数据库与 Docker Storage volume 是运行证据，不应
作为 Git 制品提交。
