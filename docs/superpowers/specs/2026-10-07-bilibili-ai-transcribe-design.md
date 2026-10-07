# B 站无字幕视频 AI 音频转写 — 设计文档

日期：2026-10-07
状态：待评审
分支规划：`feat/bilibili-ai-transcribe`

## 1. 背景与目标

B 站部分视频（如"好人松松"《新手健身看这个✔》合集）没有 CC/AI 字幕轨——字幕是压制在画面中的硬字幕，B 站接口不提供任何文本数据源，且对这些视频的接口请求还会返回"钓鱼假轨"（已由双重采样 + 时长校验拦截，见 `fix/bilibili-subtitle-notice` 分支）。

**目标**：为这类视频提供手动触发的 AI 音频转写，转写结果作为 `{{transcript}}` 变量内容，与现有字幕剪藏体验一致。

**非目标**（v1 不做）：
- 多 provider（Gemini/OpenAI 等）转写——架构上预留，仅实现 SiliconFlow
- 自动转写（无字幕自动开始）
- 其他平台（YouTube/抖音）的转写
- 句级精确时间戳（仅块级近似）

## 2. 已验证的关键事实（spike 结论）

| 项 | 结论 |
|---|---|
| 音频获取 | playurl（wbi 签名 + cookie）→ 64kbps m4s 音频流 URL，Range 下载可行 |
| Qwen3-ASR-1.7B | 9.3s/4.4min，质量接近 Gemini，**¥0.0592/4.4min ≈ ¥0.81/小时**，国内直连，**仅接受 wav**（m4a 报 500） |
| SenseVoiceSmall | 6.4s/4.4min，免费不限量，质量一般（术语错误多），接受 m4a 直传 |
| Gemini 3.8 Flash | 质量最好带时间戳，但需梯子、慢（127s/4.4min）、有费用——不做默认 |
| 浏览器解码 | AudioContext.decodeAudioData 可解 AAC/fMP4；MV3 SW 无 AudioContext，需在页面上下文执行 |
| Qwen3-ASR 文本输出 | 无时间戳，纯文本 |

## 3. 总体流程

```
剪藏 B 站视频（无字幕轨）
  → 笔记字幕区显示提示（含"该视频无字幕，可 AI 转写"说明）
  → 用户在弹窗中点击「AI 转写」按钮
  → background 启动转写任务：
      1. playurl 拿 64kbps 音频流 URL（复用 wbi 签名 + DNR cookie 注入）
      2. 分块下载（init segment + 每 ~5 分钟 fragments）
      3. 视频页 content script：decodeAudioData → 16kHz mono → WAV
      4. background 调 SiliconFlow /v1/audio/transcriptions（Qwen3-ASR-1.7B）
      5. 块结果缓存 + 断点续传；并发 3
      6. 完成 → chrome.notifications 通知
  → 用户重新剪藏 → {{transcript}} 填入转写内容（带"AI 转写"标注）
```

转写结果按 `bvid:cid` 缓存于 `chrome.storage.local`，幂等可重复使用。

## 4. 组件设计

### 4.1 音频获取与分块（background，新文件 `bilibili-audio.ts`）

- `fetchBilibiliAudioStreamUrl(bvid, cid)`：`x/player/wbi/playurl?fnval=16`，选 `dash.audio` 中 `id=30232`（64kbps），复用 `bilibili-wbi.ts` 签名与 `fetchBilibiliJsonWithCookies` 通道。
- `downloadAudioChunks(url, onChunk)`：
  - 先 Range 拉头部，扫描 `moof` box 得 fragment 边界表（不解析 sidx，字节级扫描 `moof` 魔数 + box 长度即可，实现为纯函数便于单测）
  - 聚合 fragment 为 ~5 分钟/块，每块 = initSegment + fragments，逐块产出 `ArrayBuffer`
  - 支持从已完成块索引续传（配合 storage 记录）
- 字节级 moof 扫描实现为纯函数（可单测）：输入字节流，输出 fragment 起止偏移数组。

### 4.2 解码与 WAV 编码（content script，新文件 `audio-wav-encoder.ts`）

- `decodeToWav(arrayBuffer)`：
  1. `new AudioContext().decodeAudioData(buffer)`
  2. `OfflineAudioContext(1, duration*16000, 16000)` 渲染重采样为 16kHz 单声道
  3. PCM float32 → int16，写 44 字节 WAV 头
- 内存预算：5 分钟块解码峰值 ~100MB（44.1kHz stereo float）→ 页面上下文可承受；块间释放。
- 兜底：若 `decodeAudioData` 对 fragment 序列失败（兼容性风险），回退 SenseVoiceSmall 直传 m4a 块（免转码、免费，质量降级并在结果中标注）。

### 4.3 ASR 客户端（background，新文件 `transcribe-client.ts`）

- `transcribeChunk(wavBlob, settings)`：`POST {baseUrl}/v1/audio/transcriptions`，multipart（model、file），`Authorization: Bearer <key>`
- 重试：429/5xx 指数退避 ×3；401/403 直接失败并提示检查 key/余额
- 基础 URL 默认 `https://api.siliconflow.cn`，设置可改（OpenAI 兼容端点）

### 4.4 任务编排（background，新文件 `transcribe-manager.ts`）

- 状态机：`idle → downloading → transcribing → done | failed`，进度 `{ done, total }`
- 存 `chrome.storage.session`：`transcribeTask:{bvid}:{cid}` = `{ status, chunks, startedAt, model }`
- SW 保活：`chrome.alarms.create('transcribe-heartbeat', { periodInMinutes: 0.3 })`，任务结束清除
- 并发 3，块失败重试后跳过并在结果中标注 `[第 N 段转写失败]`
- 完成/失败发 `chrome.notifications`

### 4.5 结果缓存与注入（`bilibili-extractor.ts` 扩展）

- 缓存 key：`biliTranscript:{bvid}:{cid}`，值 = `{ model, chunks: [{ startSec, text }], createdAt }`
- `extractBilibiliStructuredContent`：字幕轨为空/被判定不可信时读缓存，有则组装 transcript：
  - 每块行首标块起始时间（`mm:ss`），按章节（view_points 时间轴）归组，与现有 transcriptMarkdown 格式一致
  - `subtitleNotice` 显示"以下内容由 AI 转写生成（模型 X）"
- 主动触发转写的前置检查：缓存存在则提示已转写。

### 4.6 UI

- **popup**：B 站视频 + 无字幕时显示「AI 转写字幕」按钮；任务进行中显示进度条；完成后显示"已就绪，重新剪藏即可"。
- **settings**：新增"AI 转写"区块——SiliconFlow API Key（密码框）、模型下拉（Qwen/Qwen3-ASR-1.7B 默认 / FunAudioLLM/SenseVoiceSmall / XingChenAGI/XingChenASR-V3.2-Ultra）、自定义 base URL（高级，折叠）。
- i18n：zh_CN / en 两套文案（沿用 `_locales` 体系）。

### 4.7 消息协议（content ↔ background）

- `startBilibiliTranscribe { bvid, cid }` → 开始任务（校验设置与缓存）
- `getBilibiliTranscribeStatus { bvid, cid }` → 状态查询
- `decodeAudioToWav { arrayBuffer }`（background → content，经 tab message）→ 返回 wav ArrayBuffer

## 5. 错误处理

| 场景 | 行为 |
|---|---|
| playurl 失败/无音频流 | 通知"无法获取音频流（接口受限或视频不可见）" |
| API key 未配置 | popup 按钮点击引导到设置页 |
| 余额不足/key 无效 | 通知具体原因 |
| 块解码失败 | 单块降级 SenseVoiceSmall；再失败则标注跳过 |
| SW 被杀（极端） | storage 进度在，重新触发时续传 |
| 页面关闭（解码宿主丢失） | 任务暂停并通知"保持视频页打开" |

## 6. 测试

- 单测（vitest，纯函数）：moof 边界扫描、WAV 头编码、分块聚合、transcript 组装（块+章节归组）、缓存注入逻辑
- 编排测试：mock fetch/消息通道，覆盖续传、块失败降级、并发上限
- 手动集成：真实视频（饮食全解 110min）全链路 + 时长与费用记录

## 7. 风险与缓解

| 风险 | 缓解 |
|---|---|
| decodeAudioData 拒绝 fragment 块 | SenseVoiceSmall 直传 m4a 兜底（spike 已证可行） |
| B 站 playurl 加强风控 | 复用已验证的 wbi+cookie 通道；失败时明确报错 |
| SiliconFlow 模型下线/改价 | 模型下拉 + 自定义 base URL 可迁移 |
| 长任务 SW 生命周期 | alarms 保活 + storage 断点续传 |
| 费用失控 | 手动触发 + 每次转写前 popup 显示预计时长与参考单价（¥0.81/小时） |

## 8. 规模与里程碑

- 新文件 5 个 + 修改 4 处（extractor/popup/settings/background 消息路由/i18n 文案）
- 估 1200–1600 行（含测试）
- 单分支 `feat/bilibili-ai-transcribe`，按"音频链路 → ASR 编排 → UI → 注入"四个可验证阶段提交
