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
 * upos-*.akamaized.net 为 B 站对部分网络环境返回的 Akamai 镜像 CDN，
 * 仅允许 upos- 前缀（akamaized.net 为公共 CDN 域，不能整体放行）。
 */
export function isAllowedBilibiliFetchUrl(url: string): boolean {
	try {
		const parsedUrl = new URL(url);
		if (parsedUrl.protocol !== "https:") return false;
		const host = parsedUrl.hostname;
		return (
			host === "api.bilibili.com" ||
			host.endsWith(".hdslb.com") ||
			host.endsWith(".bilivideo.com") ||
			(host.startsWith("upos-") && host.endsWith(".akamaized.net"))
		);
	} catch {
		return false;
	}
}

function blockedError(url: string): Error {
	return new Error(`Blocked Bilibili fetch URL: ${url.slice(0, 120)}`);
}

/**
 * 通过后台统一抓取 B 站 JSON，复用登录态并补全 Referer。
 */
export async function fetchBilibiliJsonDirect(url: string): Promise<any> {
	if (!isAllowedBilibiliFetchUrl(url)) {
		throw blockedError(url);
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

/**
 * 经 DNR 临时规则为该 URL 注入指定请求头后执行 fetch（用后即删）。
 * 用于补齐 SW fetch 与页面同源请求的头差异（Cookie / Origin 等——均为
 * fetch 的禁设头，只能走 DNR）。
 */
async function withBilibiliHeaderRule<T>(
	url: string,
	requestHeaders: Array<{ header: string; value: string }>,
	doFetch: () => Promise<T>,
): Promise<T> {
	const dnr = (globalThis as any).chrome?.declarativeNetRequest;
	if (!dnr?.updateSessionRules) {
		return doFetch();
	}
	const ruleId =
		BILIBILI_COOKIE_RULE_BASE +
		((nextBilibiliCookieRuleId++ - BILIBILI_COOKIE_RULE_BASE) %
			BILIBILI_COOKIE_RULE_WINDOW);
	await dnr.updateSessionRules({
		removeRuleIds: [ruleId],
		addRules: [
			{
				id: ruleId,
				priority: 1,
				action: {
					type: "modifyHeaders" as any,
					requestHeaders: requestHeaders.map((entry) => ({
						header: entry.header,
						operation: "set" as any,
						value: entry.value,
					})),
				},
				condition: {
					regexFilter: `^${escapeRegExp(url)}$`,
					resourceTypes: ["xmlhttprequest" as any],
				},
			},
		],
	});
	try {
		return await doFetch();
	} finally {
		dnr.updateSessionRules({ removeRuleIds: [ruleId] }).catch(() => {
			// 清理失败不影响主流程，规则窗口循环复用会覆盖旧规则
		});
	}
}

export async function fetchBilibiliJsonWithCookiesDirect(
	url: string,
): Promise<any> {
	if (!isAllowedBilibiliFetchUrl(url)) {
		throw blockedError(url);
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

	return withBilibiliHeaderRule(
		url,
		[
			{ header: "Cookie", value: cookieHeader },
			{ header: "Referer", value: "https://www.bilibili.com/" },
		],
		async () => {
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
		},
	);
}

/**
 * Range 下载 B 站音视频流片段（AI 转写用）。
 * skipAllowList：URL 由内部 playurl 响应给出（可信来源，非外部输入）时跳过
 * 域名白名单——B 站 CDN 域名族谱庞大（bilivideo.com/.cn、mcdn、upos-*
 * akamaized 等），静态枚举追不完。消息协议入口（外部可发起）不得跳过。
 */
export async function fetchBilibiliRangeDirect(
	url: string,
	rangeStart: number,
	rangeEnd: number,
	opts?: { skipAllowList?: boolean },
): Promise<ArrayBuffer> {
	if (!opts?.skipAllowList && !isAllowedBilibiliFetchUrl(url)) {
		throw blockedError(url);
	}
	const readResponse = async (): Promise<ArrayBuffer> => {
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
		const buffer = await response.arrayBuffer();
		// 对端忽略 Range 返回 200 全量时截取所需区间：否则 init+整段拼出的
		// 块超出计划长度，页面解码直接 EncodingError
		if (response.status === 200 && rangeEnd >= rangeStart) {
			return buffer.slice(
				rangeStart,
				Math.min(rangeEnd + 1, buffer.byteLength),
			);
		}
		return buffer;
	};
	try {
		return await readResponse();
	} catch (error) {
		// 403 且仅 403：部分受保护内容校验 Origin（页面同源媒体请求带
		// Origin，扩展 SW 不带，且 Origin 是 fetch 禁设头）——经 DNR 注入
		// Origin+Referer 重试一次。仍 403 则为权益/风控边界，向上抛出。
		if (!/status 403/.test(String(error))) throw error;
		return withBilibiliHeaderRule(
			url,
			[
				{ header: "Origin", value: "https://www.bilibili.com" },
				{ header: "Referer", value: "https://www.bilibili.com/" },
			],
			readResponse,
		);
	}
}
