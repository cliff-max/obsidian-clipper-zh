import browser from "./utils/browser-polyfill";

/**
 * 抖音接口/CDN 的 background 直调实现（镜像 background-bilibili-fetch 的姿态）。
 *
 * 安全边界：消息协议入口（外部可发起）必须走 isAllowedDouyinFetchUrl 白名单；
 * 音频/字幕 URL 来自页面自身数据（play_url/cla_info，可信来源），但域名族谱
 * 无法穷举，因此白名单按抖音自有域收口（douyin.com / douyinvod.com /
 * amemv.com / bytecdn.cn / bytedance.com / snssdk.com）。
 */

export function isAllowedDouyinFetchUrl(url: string): boolean {
	try {
		const parsedUrl = new URL(url);
		if (parsedUrl.protocol !== "https:") return false;
		const host = parsedUrl.hostname;
		return (
			host === "www.douyin.com" ||
			host === "www.iesdouyin.com" ||
			host.endsWith(".douyin.com") ||
			host.endsWith(".douyinvod.com") ||
			// 原声轨 CDN（sf*-cdn-tos.douyinstatic.com，实测 music.play_url 域）
			host.endsWith(".douyinstatic.com") ||
			host.endsWith(".amemv.com") ||
			host.endsWith(".bytecdn.cn") ||
			host.endsWith(".bytedance.com") ||
			host.endsWith(".snssdk.com") ||
			host.endsWith(".tiktokcdn.com")
		);
	} catch {
		return false;
	}
}

function blockedError(url: string): Error {
	return new Error(`Blocked Douyin fetch URL: ${url.slice(0, 120)}`);
}

// 抖音 CDN 校验 Referer：MV3 SW 跨站请求默认只带 origin，经 declarativeNetRequest
// 临时规则注入完整 Referer（复用 B 站 cookie 注入的规则窗口模式）。
const DOUYIN_REFERER_RULE_BASE = 9200;
const DOUYIN_REFERER_RULE_WINDOW = 50;
let nextDouyinRefererRuleId = DOUYIN_REFERER_RULE_BASE;

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function withDouyinReferer<T>(
	url: string,
	doFetch: () => Promise<T>,
): Promise<T> {
	const dnr = (globalThis as any).chrome?.declarativeNetRequest;
	if (!dnr?.updateSessionRules) {
		return doFetch();
	}
	const ruleId =
		DOUYIN_REFERER_RULE_BASE +
		((nextDouyinRefererRuleId++ - DOUYIN_REFERER_RULE_BASE) %
			DOUYIN_REFERER_RULE_WINDOW);
	await dnr.updateSessionRules({
		removeRuleIds: [ruleId],
		addRules: [
			{
				id: ruleId,
				priority: 1,
				action: {
					type: "modifyHeaders",
					requestHeaders: [
						{
							header: "Referer",
							operation: "set",
							value: "https://www.douyin.com/",
						},
					],
				},
				condition: {
					regexFilter: `^${escapeRegExp(url)}$`,
					resourceTypes: ["xmlhttprequest"],
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

/**
 * 整段下载抖音音频/视频文件（转写用）。带大小上限：Range 截断 + 响应体校验。
 */
export async function fetchDouyinAudioDirect(
	url: string,
	maxBytes: number,
): Promise<ArrayBuffer> {
	if (!isAllowedDouyinFetchUrl(url)) {
		throw blockedError(url);
	}
	return withDouyinReferer(url, async () => {
		const response = await fetch(url, {
			method: "GET",
			cache: "no-store",
			headers: { Range: `bytes=0-${Math.max(0, maxBytes - 1)}` },
		});
		if (!response.ok && response.status !== 206) {
			throw new Error(
				`Douyin audio fetch failed with status ${response.status}`,
			);
		}
		const buffer = await response.arrayBuffer();
		// 对端忽略 Range 返回 200 全量时按上限截取（抖音是整段下载，
		// 请求区间即 0..max，等价于按上限防御性截断）
		if (response.status === 200 && buffer.byteLength > maxBytes) {
			throw new Error(
				`音频文件超过 ${Math.round(maxBytes / 1024 / 1024)}MB 上限，暂不支持转写`,
			);
		}
		return buffer;
	});
}

/**
 * 下载抖音 WebVTT 字幕文本（字幕轨 URL 来自页面 cla_info 数据）。
 */
export async function fetchDouyinCaptionDirect(url: string): Promise<string> {
	if (!isAllowedDouyinFetchUrl(url)) {
		throw blockedError(url);
	}
	return withDouyinReferer(url, async () => {
		const response = await fetch(url, {
			method: "GET",
			cache: "no-store",
		});
		if (!response.ok) {
			throw new Error(
				`Douyin caption fetch failed with status ${response.status}`,
			);
		}
		return await response.text();
	});
}

/** 抖音移动端 feed 接口（免签名免 cookie 的公开详情兜底）。 */
export async function fetchDouyinFeedApiDirect(
	awemeId: string,
): Promise<any> {
	const url = `https://api5-normal-c-hl.amemv.com/aweme/v1/feed/?aweme_id=${encodeURIComponent(
		awemeId,
	)}&aid=1128`;
	return withDouyinReferer(url, async () => {
		const response = await fetch(url, {
			method: "GET",
			cache: "no-store",
			headers: { Referer: "https://www.douyin.com/" },
		});
		if (!response.ok) {
			throw new Error(
				`Douyin feed api failed with status ${response.status}`,
			);
		}
		return await response.json();
	});
}

/** 转写用的抖音音频元数据（由视频页 content script 从页面数据解析）。 */
export interface DouyinAwemeAudio {
	awemeId: string;
	/** 原声轨（music.play_url）优先，回退视频本身（play_addr，muxed mp4） */
	audioUrl: string;
	audioMime: string;
	audioExt: string;
	/** 服务端未给体积时传 0（整段下载按上限校验） */
	sizeBytes: number;
	durationSec: number;
	/** 热词上下文原料：标题/作者/简介 */
	promptParts: string[];
}

/**
 * 向视频页 content script 请求当前 aweme 的音频元数据。
 * 页面关闭/无响应时给出可读错误（转写宿主依赖视频页保持打开）。
 */
export async function fetchDouyinAwemeAudio(
	tabId: number,
	awemeId: string,
): Promise<DouyinAwemeAudio> {
	let resp: any;
	try {
		resp = (await (globalThis as any).chrome?.tabs?.sendMessage?.(tabId, {
			action: "getDouyinAwemeData",
			awemeId,
		})) as any;
	} catch (error) {
		throw new Error(
			`视频页已关闭或不可用，请保持抖音视频页打开后重试（${String(error).slice(0, 80)}）`,
		);
	}
	if (!resp?.success) {
		throw new Error(resp?.error || "未能从页面获取抖音视频音频信息");
	}
	return resp.aweme as DouyinAwemeAudio;
}
