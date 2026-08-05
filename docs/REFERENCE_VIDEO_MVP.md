# 单参考视频 MVP

## 协议证据

当前安装并固定的 `maas-seedance-sdk==1.0.0` demo 与源码确认 AICC 请求使用：

```json
{
  "type": "video_url",
  "video_url": { "url": "<HTTPS_URL>" },
  "role": "reference_video"
}
```

请求含任意 `type == "video_url"` 项时，SDK 自动加入
`Input-Has-Video: true`。Seedance 专用 AICC client 将请求 JSON 原样交给
`POST /api/v3/contents/generations/tasks`；Console 不采用其他产品或普通火山 API 的字段
进行推测。

SDK demo 提示词使用“视频1”引用第一段参考视频，但 SDK 不校验编号，因此 Console UI
建议用户明确写“视频1”，不把它声明为 AICC 强制语法。

## 能力边界

公开模型资料可作为实现参考：最多 3 段、单段 2–15 秒、总时长不超过 15 秒，列出的
格式为 MP4/MOV，分辨率为 480p/720p/1080p/4K。这些不是当前 AICC 租户的合同限制。

当前 MVP 主动收窄为：

- 每个任务最多一段参考视频；
- 仅 `video/mp4` 与 `.mp4` 扩展名同时匹配；
- 时长 2–15 秒；
- `APP_VIDEO_MAX_BYTES` 是 Console 本地安全上限，不是 Provider 限制；
- ffprobe 采集编码、像素格式、分辨率、帧率和音轨信息，但不把 H.264、24 fps 或无
  音轨写成 Provider 白名单；
- MOV、多视频、视频与图片组合留待后续扩展。

## 后续 TODO：多参考素材

当前 Console 在 Seedance 模式下将参考图片和参考视频合计限制为一项。该限制属于本地
MVP 策略，不能表述为 AICC 或模型的完整能力边界。后续扩展前需要完成以下核查与实现：

- [ ] 审计届时实际安装的 AICC SDK、租户协议和服务商示例，确认是否允许多张图片、
  多段视频，以及图片与视频混合输入；不得套用普通火山 API 字段进行推测。
- [ ] 确认每种素材及所有素材合计的数量、大小、时长限制，明确素材顺序是否影响
  `图片1/视频1` 等提示词编号，并记录是否存在必需的 role 或请求头。
- [ ] 将 capabilities 拆分为图片数量、视频数量和混合素材总数三个明确限制，区分
  Provider 已确认能力与 Console 本地安全策略。
- [ ] 扩展 API 校验与 Worker payload 映射，保持素材顺序稳定，并为每段视频继续生成
  `video_url + reference_video`；存在任意视频时只设置一次 `Input-Has-Video: true`。
- [ ] 扩展 EOS 发布与清理，使多个临时对象在部分上传失败、Provider 明确拒绝、
  `OUTCOME_UNKNOWN`、各远端终态及成功下载后都遵守现有清理门禁且可幂等恢复。
- [ ] 更新创建页以支持多素材的添加、删除、排序和数量提示；达到限制时显示明确原因，
  不再让被禁用的上传控件表现为“点击没有反应”。
- [ ] 增加多图片、多视频、图片与视频组合、顺序/编号、部分失败清理、并发清理、
  Mock 隔离及 URL/凭证泄漏测试，确保现有单素材流程保持兼容。
- [ ] 完成 mock 和不发送 create 的 payload dry-run 后暂停；任何真实多素材验证仍需用户
  对一次 create 单独明确授权。

## 文件与发布安全

API 先以随机 storageKey 原子落入 Local Storage 临时文件，再由 ffprobe 从受控流检查
MP4 容器、时长与媒体元数据。扩展名伪装、损坏/不可解析文件、大小超限和路径逃逸均
拒绝。Asset 保存 SHA-256、大小、时长、宽高、编码、像素格式、帧率和是否含音轨。

Worker 在 create 前重新读取并校验文件、SHA-256 和元数据。EOS 对象使用
`seedance-inputs/videos/<256-bit-random>`，Bucket 保持私有，URL 仅存在于 Worker 当前
调用内存。数据库只保存 publisher、Bucket、object key、过期时间和清理状态；任务 API
不返回 object key、URL 或绝对路径。

EOS 清理受数据库 `providerAssetCleanupReadyAt` 门禁约束：确认未创建时立即允许清理；
已绑定 providerTaskId 后，只有远端明确 FAILED/CANCELLED/EXPIRED，或 SUCCEEDED 输出完成
下载、原子持久化和校验后才允许清理。`OUTCOME_UNKNOWN`、`RECONCILIATION_REQUIRED`、
远端处理中和本地 poll 超时均禁止清理。DeleteObject 重复执行安全；删除失败只记录
`OBJECT_DELETE_FAILED`，不覆盖任务终态。

## 本次已测试输入配置

以下仅记录本次素材事实，不声明为 Provider 白名单：

```text
taskId:      cms9w5wu70006lj019o2gbni8
container:   MP4
codec:       H.264/AVC
pixelFormat: yuv420p
resolution:  1280x720
frameRate:   24 fps
duration:    11.041667 s
audio:       none
size:        7,309,809 bytes
sha256:      6ea9470b628cf49913b647f7431fa86594bef2f3719482ea25e7f16ddce1f7eb
```

真实 Provider create 必须继续受 `SEEDANCE_PROVIDER`、`REAL_API_TEST` 和用户单次明确授权
三重边界约束。fixture、EOS GET 或 payload dry-run 均不构成真实 create 授权。

## 真实 E2E 验收

2026-08-02 已使用上述 MP4 完成一次且仅一次真实视频生视频 create：Provider 状态
`accepted → running → succeeded`，输出 6,254,602 字节，storageKey 为
`outputs/cmsbwzh9w0000o90144jhj1q3/video.mp4`，SHA-256 为
`9636a5981ee542180ce24e7783931baff607a87d5c23ca93ea4a8d9819c5bf38`。播放/下载 API
校验通过，EOS 临时对象删除后 HeadObject 为 404，敏感信息泄漏扫描为 0。验收中发现的
带时区偏移时间戳解析和 EOS 提前清理缺陷已按本文门禁修复并纳入回归测试。
