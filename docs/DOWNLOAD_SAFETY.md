# Provider 输出下载与恢复

## 阶段边界

Provider 返回 `succeeded` 只表示输出可以获取。Poll processor 使用当前 poll
租约将任务保持为 `PROCESSING`，持久化 `downloadPending=true` 和首个
`downloadVersion`，然后投递：

```text
provider-download-<taskId>-v<downloadVersion>
```

Job payload 只包含 `taskId`、`providerTaskId` 和 `downloadVersion`，不包含
Provider URL、请求头、凭据或响应内容。只有文件和 `VideoOutput` 元数据在同一
恢复流程中均持久化后，任务才会条件更新为 `SUCCEEDED`。

## 版本、租约与协调器

PostgreSQL 是下载调度的事实来源：

| 字段                 | 语义                                         |
| -------------------- | -------------------------------------------- |
| `downloadPending`    | Provider 输出已就绪、尚未完成本地持久化      |
| `downloadStartedAt`  | 下载阶段首次开始时间                         |
| `nextDownloadAt`     | 当前版本允许执行的时间；为空表示停止自动推进 |
| `lastDownloadAt`     | 最近一次下载处理完成或失败的时间             |
| `downloadDeadlineAt` | 本地下载阶段的最大期限                       |
| `downloadLeaseUntil` | 当前版本的执行租约                           |
| `downloadVersion`    | 当前唯一有效 job 版本                        |
| `downloadAttempt`    | 已处理的失败次数                             |
| `downloadErrors`     | 连续可重试错误次数                           |
| `lastDownloadError`  | 脱敏后的稳定错误码                           |

Worker 以 `PROCESSING + providerTaskId + downloadPending +
downloadVersion + downloadLeaseUntil` 条件更新抢占租约。完成、重试、停止和输出
失效修复都再次使用同一租约条件。旧版本、重复 job、终态任务和取消后的任务因此
无法写回状态。

数据库先提交新版本及 `nextDownloadAt`，再投递 BullMQ delayed job。投递失败、
Redis 丢 job 或 Worker 重启时，现有协调器按批次扫描到期记录，并用确定性 job
ID 补投；恢复路径不会调用 `createTask()`，也不会重新进入 poll。

## 临时文件与原子提交

本地存储使用固定流程：

1. 最终 key 固定为 `outputs/<taskId>/video.mp4`，task ID 必须通过内部字符集校验。
2. 在 `<storage-root>/.tmp/downloads` 下创建随机、权限为 `0600` 的
   `.partial` 文件。
3. 流式写入期间计算 SHA-256，并同时执行超时和最大字节数限制。
4. 写完后 `fsync` 文件，再从临时文件重新校验 MP4 容器。
5. 校验通过后原子 rename 到最终 key，并 `fsync` 最终目录。
6. 任何可捕获失败都会销毁输入流并删除本次临时文件。

允许的 MIME 当前只有精确的 `video/mp4`。若 Provider 提供 Content-Length，
会在读取前拒绝空值、非法值和超限值；没有或伪造长度时，流式限制仍然生效。
MP4 校验要求完整的顶层 box 边界、首个 `ftyp`，并同时存在完整的 `moov` 和
`mdat`，因此不依赖扩展名。

## 文件与数据库一致性

`VideoOutput.taskId`、`assetId` 和 `storageKey` 均唯一，并保存
`providerTaskId`、SHA-256、文件大小和 MIME：

- 文件已提交但数据库事务失败：重试按确定性 key 校验文件并补写
  `Asset`、`TaskAsset` 和 `VideoOutput`，不再次请求 Provider。
- `VideoOutput` 已存在但任务仍为 `PROCESSING`：校验文件和元数据后，仅执行
  条件事务完成任务。
- 元数据存在但文件缺失或校验失败：在仍持有当前租约时删除失效元数据；只删除
  本任务确定性 key 下的损坏文件，再重新下载。
- 取消先落库：最终事务的条件更新失败并整体回滚，绝不覆盖 `CANCELLED`。已原子
  落盘但尚无引用的确定性文件保留，后续受控清理或诊断可以识别它。

## 错误与重试

网络中断、请求超时、429、明确可重试的 5xx 和临时 Bridge 故障使用可配置指数
退避、有界抖动、最大尝试次数和 `downloadDeadlineAt`。401、403、输出过期、
非法 MIME、超限、空文件、截断或错误 MP4、协议字段缺失会停止自动推进并记录
稳定错误码，任务保持 `PROCESSING` 等待人工处理。下载重试既不调用
`createTask()`，也不重新安排 Provider poll。

## 网络与 SSRF 边界

Worker 只消费 `ProviderRuntime.downloadOutput()` 返回的受控流，不接受或解析
Provider URL。Seedance 路径只允许访问部署配置中的私有 Bridge endpoint；签名
URL 由未来 Bridge/SDK 在其私有边界内解析和解密，不能进入 job、数据库或日志。

当前没有“任意 URL 下载”路径，因此不存在基于 fixture 绕过 URL 校验的分支。
若未来引入 direct URL transport，必须在启用前实现 HTTPS 强制、域名允许列表、
DNS/IP 内网及环回拒绝、每次重定向重新校验和重定向次数上限。
