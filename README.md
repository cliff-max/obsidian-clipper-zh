# Obsidian Clipper ZH

> 基于官方 [Obsidian Web Clipper](https://github.com/obsidianmd/obsidian-clipper) 的中文内容增强 Fork，专注中文平台与视频字幕体验。

Fork 谱系：[obsidianmd/obsidian-clipper](https://github.com/obsidianmd/obsidian-clipper)（官方）→ [nextcaicai/obsidian-clipper-cn](https://github.com/nextcaicai/obsidian-clipper-cn)（中文平台增强）→ **本项目**（视频字幕深度修复与双语支持）。

## 与上游有什么不同？

### Bilibili 视频：AI 字幕真正可用了

上游（含官方 cn 版）在已登录浏览器里剪藏 B 站视频，经常出现「章节拿到了、字幕却为空」或时好时坏的情况。根因是 Chrome MV3 的安全模型：**扩展发起的所有网络请求（包括注入页面的脚本）initiator 都标记为扩展自身，SameSite cookie（B 站登录态 SESSDATA）一律不随请求发出**——需要登录态的 AI 字幕轨因此永远拿不到。

本项目的修复：

- **三级回退链**：匿名请求（wbi/v2 签名 → v2）→ **DNR 注入登录 cookie 重试**（读取 B 站 cookie，经 `declarativeNetRequest` 临时规则注入 Cookie 头，请求完成即删规则，cookie 仅在内存中拼装、只发往 B 站自有接口）→ 页面上下文兜底
- **完整 wbi 签名实现**（nav 取 key → mixin 重排 → MD5），通过 bilibili-API-collect 参考用例逐字节验证
- **字幕缺失显式提示**：拿不到字幕时在笔记中标注原因（未登录 / 无字幕 / 接口受限），不再静默空白
- 继承上游全部能力：简介/章节/字幕结构化提取、阅读视图内嵌播放器、时间戳点击跳转、自动滚动与当前行高亮

### YouTube：中英双语字幕

官方版本只能抓取视频原语言的单一字幕轨。本项目在抓取原轨的同时并发请求 YouTube 官方机器翻译轨（`tlang=zh-Hans`），按时间戳逐句对齐，渲染为**英文在上、中文在下**的对照格式，阅读外语音像内容时无需来回查词。原轨本身是中文的视频自动跳过翻译。

实现方式是对 [defuddle](https://github.com/kepano/defuddle) v0.16.0 的补丁（`patches/defuddle+0.16.0.patch`，经 [patch-package](https://github.com/ds300/patch-package) 固化，`npm install` 时自动应用），对齐容差 5 秒，翻译轨获取失败时自动回退单语，不影响原有行为。

### 继承自上游 cn 版的增强

- **飞书文档完整提取** — 接入飞书开放平台 API，结构化获取全部块内容（文字/标题/列表/代码块/表格/引用），支持知识库 `/wiki/` 与普通文档 `/docx/`，文档图片转 base64 嵌入
- **微信公众号文章优化** — 优先使用 `#js_content` 原始正文容器，修复懒加载图片（`data-src` 等），多图文章完整保存

## 安装

### 方式一：下载构建产物（无需 Node.js）

从 [Releases](https://github.com/cliff-max/obsidian-clipper-zh/releases) 下载对应浏览器的 zip：

- **Chrome / Edge 等 Chromium 系**：解压后打开 `chrome://extensions` → 开启「开发者模式」→「加载已解压的扩展程序」→ 选择解压目录
- **Firefox**：`about:debugging#/runtime/this-firefox` 临时载入；永久安装需 Nightly/Developer 版并将 `xpinstall.signatures.required` 设为 `false`

> 剪藏 B 站 AI 字幕需要浏览器已登录 B 站账号。

### 方式二：源码构建

```bash
git clone https://github.com/cliff-max/obsidian-clipper-zh.git
cd obsidian-clipper-zh
npm install        # 自动应用 defuddle 补丁
npm run build:chrome    # 产物在 dist/，zip 在 builds/
```

## 致谢

- [obsidianmd/obsidian-clipper](https://github.com/obsidianmd/obsidian-clipper) 与 [kepano](https://github.com/kepano) — 官方剪藏器与内容提取库
- [nextcaicai](https://github.com/nextcaicai) — 中文平台增强（B 站/飞书/公众号）
- [bilibili-API-collect](https://github.com/SocialSisterYi/bilibili-API-collect) — wbi 签名算法参考

## License

MIT（继承自上游，保留原版权声明）
