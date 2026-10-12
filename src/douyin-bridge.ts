/**
 * Runs in the page's MAIN world on douyin.com.
 *
 * SPA 导航（feed → 视频页）时，详情数据由页面自身经 XHR/fetch 获取且带
 * a_bogus 签名——扩展侧无法自行构造该签名。此桥只做"记录"：拦截页面自己
 * 发出的 aweme detail/feed 接口响应，把 aweme JSON 缓存在
 * window.__ocClipperDyBridge，扩展经 chrome.scripting.executeScript(world:MAIN)
 * 读取。不发请求、不改请求，签名完全由页面完成。
 */
(function () {
	const win = window as any;
	if (win.__ocClipperDyBridgeInstalled) return;
	win.__ocClipperDyBridgeInstalled = true;

	const MAX_ENTRIES = 60;
	const store = win.__ocClipperDyBridge ?? { byId: {} };
	win.__ocClipperDyBridge = store;

	// 按 URL 前缀粗筛 + 按响应形状吸收（absorb 只认 aweme_detail/aweme_list）。
	// 实测 PC 端：详情走 /aweme/v1/web/aweme/detail/，推荐流走
	// /aweme/v2/web/module/feed/（v2！），用户作品走 /aweme/v1/web/aweme/post/。
	// 前缀放宽到 v1/v2 全量，避免抖音端点迁移再次漏捕。
	const isAwemeApiUrl = (url: unknown): boolean =>
		typeof url === "string" &&
		(url.includes("/aweme/v1/web/") || url.includes("/aweme/v2/web/"));

	const absorb = (json: any): void => {
		try {
			const items: any[] = [];
			if (json?.aweme_detail) items.push(json.aweme_detail);
			if (json?.data?.aweme_detail) items.push(json.data.aweme_detail);
			if (Array.isArray(json?.aweme_list)) items.push(...json.aweme_list);
			if (Array.isArray(json?.data?.aweme_list))
				items.push(...json.data.aweme_list);
			let added = false;
			for (const aweme of items) {
				if (aweme?.aweme_id) {
					store.byId[String(aweme.aweme_id)] = {
						aweme,
						ts: Date.now(),
					};
					added = true;
				}
			}
			if (added) {
				const ids = Object.keys(store.byId);
				if (ids.length > MAX_ENTRIES) {
					ids.sort((a, b) => store.byId[a].ts - store.byId[b].ts)
						.slice(0, ids.length - MAX_ENTRIES)
						.forEach((id) => delete store.byId[id]);
				}
			}
		} catch {
			// 页面数据格式异常时静默跳过
		}
	};

	const absorbText = (text: string): void => {
		try {
			absorb(JSON.parse(text));
		} catch {
			// 非 JSON（流式分片等）忽略
		}
	};

	const origFetch = win.fetch?.bind(win);
	if (origFetch) {
		win.fetch = async (...args: any[]) => {
			const response = await origFetch(...args);
			try {
				const url =
					typeof args[0] === "string"
						? args[0]
						: (args[0]?.url as string | undefined) || "";
				if (isAwemeApiUrl(url)) {
					response
						.clone()
						.text()
						.then(absorbText)
						.catch(() => {});
				}
			} catch {
				// 拦截失败不影响页面原始行为
			}
			return response;
		};
	}

	const origOpen = XMLHttpRequest.prototype.open;
	const origSend = XMLHttpRequest.prototype.send;
	XMLHttpRequest.prototype.open = function (
		this: XMLHttpRequest & { __ocClipperUrl?: string },
		...args: any[]
	) {
		this.__ocClipperUrl = String(args[1] ?? "");
		return origOpen.apply(this, args as any);
	};
	XMLHttpRequest.prototype.send = function (
		this: XMLHttpRequest & { __ocClipperUrl?: string },
		...args: any[]
	) {
		const url = this.__ocClipperUrl || "";
		if (isAwemeApiUrl(url)) {
			this.addEventListener("load", () => {
				try {
					absorbText(this.responseText);
				} catch {
					// 忽略
				}
			});
		}
		return origSend.apply(this, args as any);
	};
})();
