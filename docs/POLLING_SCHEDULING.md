# Provider 版本化轮询实现

## 边界

Worker 队列使用三个互斥任务类型：

- `provider-submit`：只抢占提交权、创建或恢复 Provider task ID，并持久化首次轮询计划。
- `provider-poll`：携带 `taskId + pollVersion`，每次最多查询 Provider 一次。
- `provider-download`：携带 `taskId + providerTaskId + downloadVersion`，
  负责安全流式下载、校验、原子提交和数据库恢复；详见
  [Provider 输出下载与恢复](DOWNLOAD_SAFETY.md)。

Job 不携带提示词、素材 URL、Provider 响应、下载 URL 或凭据。

## 数据库调度字段

`VideoTask` 新增：

| 字段                  | 语义                                       |
| --------------------- | ------------------------------------------ |
| `pollStartedAt`       | 本地轮询周期开始时间                       |
| `nextPollAt`          | 当前版本应执行的时间；为空表示不再自动轮询 |
| `lastPolledAt`        | 最近一次完成查询处理的时间                 |
| `pollDeadlineAt`      | 本地最大轮询期限                           |
| `pollLeaseUntil`      | 当前版本查询租约；防止并发 Worker 同时生效 |
| `pollVersion`         | 当前唯一有效的 poll job 版本               |
| `pollAttempt`         | 已完成处理的轮询次数                       |
| `pollTransientErrors` | 连续可重试错误次数                         |
| `lastProviderStatus`  | 脱敏、截断后的最后 Provider 状态           |
| `lastPollError`       | 稳定内部错误码，不保存原始响应             |
| `downloadPending`     | Provider 输出已就绪、等待独立下载任务      |

下载阶段使用独立的 `downloadVersion + downloadLeaseUntil`，不会复用或推进
`pollVersion`。Provider 成功后 `nextPollAt` 被清空，下载重试不重新进入轮询。

所有旧任务的 `nextPollAt`、`pollStartedAt` 和 `pollDeadlineAt` 均为
`NULL`，因此升级后不会被协调器误识别为待恢复任务。

## 并发与恢复

Poll Worker 使用 `status=PROCESSING + providerTaskId + pollVersion +
pollLeaseUntil + downloadPending=false` 条件更新抢占一次查询。重复 job、旧版本
job、终态任务和已取消任务都无法获得租约。

查询结果也使用相同版本和租约条件提交。若查询期间任务被取消、版本已推进或租约被新 Worker 接管，旧结果不会覆盖数据库。

数据库先提交新的 `nextPollAt + pollVersion`，随后投递 delayed job。投递失败时，
启动及周期协调器批量扫描到期记录并使用确定性 job ID 恢复。Redis 丢失不影响
PostgreSQL 中的调度事实，也不会触发 `createTask()`。

## 退避与终止

- 正常 `pending/queued/running` 使用基础间隔并清零连续错误。
- 429 和明确可重试的暂时错误按连续错误次数指数退避，并受最大间隔限制。
- 可信 `retryAfterMs` 是下一次延迟的下限。
- 抖动比例、基础/最大间隔和最大总时长均来自 Worker 配置。
- 认证、请求拒绝和协议错误停止自动轮询，任务保持 `PROCESSING` 并记录稳定错误码，等待人工处理。
- 达到本地期限后进入内部 `EXPIRED`，原因固定为
  `LOCAL_POLL_DEADLINE_EXCEEDED`；这不表示 Provider 返回了 expired 或任务已远端取消。
- Provider `succeeded` 仅设置 `downloadPending=true` 并投递 download job；在本地输出持久化前内部状态仍是 `PROCESSING`。
