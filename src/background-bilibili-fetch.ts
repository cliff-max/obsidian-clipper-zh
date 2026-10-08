import browser from "./utils/browser-polyfill";

/**
 * B 站接口的直调实现：仅供 background（service worker）内部使用。
 *
 * 重要：background 里绝不能用 chrome.runtime.sendMessage 调用这些能力——
 * Chrome 规定消息不投递给发送者自身，SW 给自己发消息必然
 * "Could not establish connection"。content script 侧请继续走消息协议
 * （见 background.ts 的消息处理器与 bilibili-audio.ts 的消息版封装）。
 */

/**
 * 判断是否允许通过后台代理抓取 B 站接口。
 */
export function isAllowedBilibiliFetchUrl(url: string): boolean {
	try {
		const parsedUrl = new URL(url);
		return (
			parsedUrl.protocol === "https:" &&
			(parsedUrl.hostname === "api.bilibili.com" ||
				parsedUrl.hostname.endsWith(".hdslb.com") ||
				parsedUrl.hostname.endsWith(".bilivideo.com"))
		);
	} catch {
		return false;
	}
}

/**
 * 通过后台统一抓取 B 站 JSON，复用登录态并补全 Referer。
 */
export async function fetchBilibiliJsonDirect(url: string): Promise<any> {
	if (!isAllowedBilibiliFetchUrl(url)) {
		throw new Error("Blocked Bilibili fetch URL");
	}
	const response = await fetch(url, {
		method: "GET",
		credentials: "include",
		cache: "no-store",
		headers: {
			Referer: "https://www.bilibili.com/",
		},
	});
	if (!response.ok) {
		throw new Error(`Bilibili fetch failed with status ${response.status}`);
	}
	return response.json();
}

// MV3 下 SW 发起的跨站请求不带 SameSite cookie（B 站 SESSDATA 登录态），
// AI 字幕因此拿不到。此处用 cookies API 读 B 站 cookie，经 declarativeNetRequest
// 临时规则注入 Cookie 头，让 SW 请求携带登录态。cookie 仅在内存中拼装并发往
// B 站自有接口，不做任何留存。
const BILIBILI_COOKIE_RULE_BASE = 9100;
const BILIBILI_COOKIE_RULE_WINDOW = 100;
let nextBilibiliCookieRuleId = BILIBILI_COOKIE_RULE_BASE;

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function fetchBilibiliJsonWithCookiesDirect(
	url: string,
): Promise<any> {
	if (!isAllowedBilibiliFetchUrl(url)) {
		throw new Error("Blocked Bilibili fetch URL");
	}
	if (
		!(globalThis as any).chrome?.declarativeNetRequest
			?.updateSessionRules ||
		!browser.cookies?.getAll
	) {
		throw new Error("Cookie-injected fetch unsupported on this browser");
	}

	const cookies = await browser.cookies.getAll({
		url: "https://api.bilibili.com/",
	});
	if (!cookies.length) {
		throw new Error(
			"No Bilibili cookies found (browser may be logged out)",
		);
	}
	const cookieHeader = cookies
		.map((cookie) => `${cookie.name}=${cookie.value}`)
		.join("; ");

	const ruleId =
		BILIBILI_COOKIE_RULE_BASE +
		((nextBilibiliCookieRuleId++ - BILIBILI_COOKIE_RULE_BASE) %
			BILIBILI_COOKIE_RULE_WINDOW);
	await (globalThis as any).chrome.declarativeNetRequest.updateSessionRules({
		removeRuleIds: [ruleId],
		addRules: [
			{
				id: ruleId,
				priority: 1,
				action: {
					type: "modifyHeaders" as any,
					requestHeaders: [
						{
							header: "Cookie",
							operation: "set" as any,
							value: cookieHeader,
						},
						{
							header: "Referer",
							operation: "set" as any,
							value: "https://www.bilibili.com/",
						},
					],
				},
				condition: {
					regexFilter: `^${escapeRegExp(url)}$`,
					resourceTypes: ["xmlhttprequest" as any],
				},
			},
		],
	});

	try {
		const response = await fetch(url, {
			method: "GET",
			credentials: "omit",
			cache: "no-store",
		});
		if (!response.ok) {
			throw new Error(
				`Bilibili fetch failed with status ${response.status}`,
			);
		}
		return await response.json();
	} finally {
		(globalThis as any).chrome.declarativeNetRequest
			.updateSessionRules({
				removeRuleIds: [ruleId],
			})
			.catch(() => {
				// 清理失败不影响主流程，规则窗口循环复用会覆盖旧规则
			});
	}
}

/**
 * Range 下载 B 站音视频流片段（AI 转写用）。
 */
export async function fetchBilibiliRangeDirect(
	url: string,
	rangeStart: number,
	rangeEnd: number,
): Promise<ArrayBuffer> {
	if (!isAllowedBilibiliFetchUrl(url)) {
		throw new Error("Blocked Bilibili fetch URL");
	}
	const response = await fetch(url, {
		method: "GET",
		cache: "no-store",
		headers: {
			Referer: "https://www.bilibili.com/",
			Range: `bytes=${rangeStart}-${rangeEnd}`,
		},
	});
	if (!response.ok && response.status !== 206) {
		throw new Error(
			`Bilibili range fetch failed with status ${response.status}`,
		);
	}
	return await response.arrayBuffer();
}
