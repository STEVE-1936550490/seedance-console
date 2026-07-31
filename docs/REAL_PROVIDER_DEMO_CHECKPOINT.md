# 真实 Provider Demo 最终检查点

记录时间：2026-07-31（Asia/Shanghai）

## 1. 最终结论

首次有效的真实收费 Seedance Demo 已成功完成。修正 Provider Base URL 后，唯一一次
到达已确认 `/api/v3` 创建端点的真实 create 成功返回 providerTaskId，随后完整通过：

```text
create → provider accepted → versioned poll → SDK download/decrypt
       → MP4 validation → local persistence → Web playback/download
```

不得再次创建新的真实收费任务。任何后续真实 create 都需要新的用户明确授权；不得
重新提交本文记录过的任何 `clientRequestId`。

## 2. 唯一成功真实任务

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

## 3. Create 次数口径

本次有效真实 create 总次数为 **1**，即成功任务
`cgt-20260731221858-8z7zj`。不得重复创建。

在成功前曾有请求因部署配置中的 `AICC_BASE_URL` 缺少 `/api/v3` 而命中错误路径：

- SDK 模型映射请求返回 HTTP 404；
- 创建请求也返回 HTTP 404，且没有 providerTaskId；
- 请求没有到达本文确认的 `/api/v3/contents/generations/tasks` 创建端点；
- 系统没有自动重发，相关本地任务保持 `SUBMITTING / OUTCOME_UNKNOWN`。

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

- Python Bridge tests：12/12，包含旧注册表原位升级。
- TypeScript tests：12 个测试文件、88/88。
- `pnpm lint`：通过。
- `pnpm typecheck`：通过。
- `pnpm build`：通过。
- 客户端密钥扫描：通过。
- Prisma validate、migrate status、migrate deploy：通过，5 个 migration 已应用。
- `docker compose config --quiet`：通过。
- PostgreSQL、Redis、API、Worker、Provider Bridge：healthy。
- 唯一真实任务 create、poll、download、本地持久化、Web 播放与下载：通过。
- Mock 模式恢复：通过。
- 真实 create 关闭门：`403 / REAL_API_TEST_DISABLED`。

## 8. 当前限制与后续 TODO

- 不再执行真实收费 create；如未来确需执行，必须获得新的明确授权。
- 真实 Demo 只验收了纯文生视频；真实参考图片、视频和音频素材组合尚未验收。
- Provider 远端取消语义仍未确认，当前明确报告不支持。
- Provider 未返回用量、Token 或费用字段，继续保持空用量，不做推测。
- Provider 正式错误码、限流规则、输出 URL TTL 和远端幂等能力仍待官方确认。
- Direct TypeScript transport 仍禁用；AICC 真实路径继续使用私有 Python Bridge。
- 对象存储/MinIO/S3、复杂 RBAC、多租户、支付不属于当前 MVP。

## 9. 工作区状态

本轮代码和文档尚未 commit 或 push。继续工作时必须保留已有改动，先执行
`git status`，不得把成功任务或历史 outcome-unknown 任务重置后重新提交。
