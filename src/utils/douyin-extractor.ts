import browser from "./browser-polyfill";
import { createLogger } from "./logger";
import {
	TRANSCRIBE_NEED_EVENT,
	type BilibiliTranscriptCue,
	buildBilibiliTranscriptMarkdown,
	splitTextIntoCues,
} from "./bilibili-extractor";

const logger = createLogger("Douyin");

/**
 * 抖音剪藏范围：仅在「正在观看单个视频」时启用（/video/{awemeId}）。
 * 首页 feed、搜索页、用户主页陈列、图集 note 页一律不纳入——多视频陈列页
 * 没有明确的主剪藏对象（与 B 站首页不剪藏字幕同一语义）。
 */
export function isDouyinSiteUrl(url: string): boolean {
	try {
		const host = new URL(url).hostname;
		return host === "www.douyin.com" || host.endsWith(".douyin.com");
	} catch {
		return false;
	}
}

export function isDouyinVideoUrl(url: string): boolean {
	try {
		const parsedUrl = new URL(url);
		if (
			parsedUrl.hostname !== "www.douyin.com" &&
			parsedUrl.hostname !== "www.iesdouyin.com"
		) {
			return false;
		}
		return /^\/video\/(\d+)/.test(parsedUrl.pathname);
	} catch {
		return false;
	}
}

/**
 * 沉浸式单列 feed 页（推荐流/关注流/精选）：用户停下来观看的视频即"正在观看"，
 * 剪藏应提取当前视频。与陈列页（用户主页/收藏/搜索的多视频网格）区分。
 * /jingxuan：未登录推荐流的重定向目标，同为沉浸式 feed。
 */
export function isDouyinFeedUrl(url: string): boolean {
	try {
		const parsedUrl = new URL(url);
		if (parsedUrl.hostname !== "www.douyin.com") return false;
		return (
			parsedUrl.pathname === "/" ||
			parsedUrl.pathname === "/follow" ||
			parsedUrl.pathname === "/discover" ||
			parsedUrl.pathname === "/jingxuan"
		);
	} catch {
		return false;
	}
}

/** UP 主主页（/user/{secUid}）。点击作品可能导航到 /video/{id}，也可能在页内模态播放。 */
export function isDouyinUserUrl(url: string): boolean {
	try {
		const parsedUrl = new URL(url);
		if (parsedUrl.hostname !== "www.douyin.com") return false;
		return /^\/user\//.test(parsedUrl.pathname);
	} catch {
		return false;
	}
}

/**
 * 页面上是否有正在播放的大尺寸 video 元素（主页网格本身没有播放器；
 * 页内模态播放时会出现视口内的大 video）。用于判断 /user 页是否处于
 * "正在观看某个视频"状态。
 */
export function hasPlayingDouyinVideo(doc: Document): boolean {
	return Array.from(doc.querySelectorAll("video")).some((element) => {
		const rect = (element as HTMLVideoElement).getBoundingClientRect?.();
		return !!rect && rect.width > 200 && rect.height > 100;
	});
}

export function parseDouyinUrl(url: string): { awemeId: string | null } {
	try {
		const match = new URL(url).pathname.match(/^\/video\/(\d+)/);
		return { awemeId: match?.[1] || null };
	} catch {
		return { awemeId: null };
	}
}

/**
 * 在 SSR 数据（__UNIVERSAL_DATA_FOR_REHYDRATION__）中探测 aweme 详情。
 * 抖音历史版本路径有变体，按「能找到带 aweme_id 的对象」逐个探测。
 */
export function findAwemeInDouyinSsr(data: any): any | null {
	if (!data || typeof data !== "object") return null;
	const candidates: any[] = [];
	const app = data.app;
	if (app?.videoInfoRes?.item_list) {
		candidates.push(app.videoInfoRes.item_list[0]);
	}
	const loaderData = data.loaderData;
	if (loaderData && typeof loaderData === "object") {
		for (const value of Object.values<any>(loaderData)) {
			const info = value?.videoInfoRes?.item_list?.[0];
			if (info) candidates.push(info);
			if (value?.videoInfoRes?.item_list?.[0]) {
				// 已覆盖
			}
			const pageData = value?.page?.videoInfoRes?.item_list?.[0];
			if (pageData) candidates.push(pageData);
		}
	}
	if (Array.isArray(data.item_list)) candidates.push(data.item_list[0]);
	if (data.aweme_detail) candidates.push(data.aweme_detail);
	return candidates.find((item) => item && item.aweme_id) || null;
}

/** 直读页面内嵌数据 script（__UNIVERSAL_DATA_FOR_REHYDRATION__ /
 * RENDER_DATA）。实测现行视频页两者都不含 aweme（数据靠 detail XHR），
 * 仅作历史/灰度形态的兜底探测。 */
export function readDouyinSsrAweme(doc: Document): any | null {
	const raws: Array<string | null | undefined> = [
		doc.querySelector("script#__UNIVERSAL_DATA_FOR_REHYDRATION__")
			?.textContent,
	];
	const renderRaw = doc.querySelector("script#RENDER_DATA")?.textContent;
	if (renderRaw) {
		try {
			raws.push(decodeURIComponent(renderRaw));
		} catch {
			raws.push(renderRaw);
		}
	}
	for (const raw of raws) {
		if (!raw) continue;
		try {
			const aweme = findAwemeInDouyinSsr(JSON.parse(raw));
			if (aweme) return aweme;
		} catch {
			// 尝试下一个数据源
		}
	}
	return null;
}

export interface DouyinCaptionTrack {
	url: string;
	lang: string;
}

export interface DouyinAwemeInfo {
	awemeId: string;
	title: string;
	description: string;
	author: string;
	createTimeSec: number;
	cover: string;
	durationMs: number;
	isImageAlbum: boolean;
	captions: DouyinCaptionTrack[];
	audioUrl: string;
	audioMime: string;
	audioExt: string;
	audioSizeBytes: number;
}

function firstUrl(urlList: any): string {
	if (!Array.isArray(urlList)) return "";
	for (const item of urlList) {
		if (typeof item === "string" && item.startsWith("http")) return item;
	}
	return "";
}

/**
 * 把抖音 aweme JSON 归一为剪藏所需信息（纯函数，可单测）。
 * 字幕轨：video.cla_info.caption_infos（AI 字幕 WebVTT），兼容
 * video.subtitle_infos；音频：music.play_url（原声）优先，回退 play_addr。
 */
export function extractDouyinAwemeInfo(aweme: any): DouyinAwemeInfo | null {
	if (!aweme || !aweme.aweme_id) return null;
	const video = aweme.video || {};
	const desc = String(aweme.desc || "").trim();
	const musicUrl = firstUrl(aweme.music?.play_url?.url_list);
	const playUrl =
		firstUrl(video.play_addr?.url_list) ||
		firstUrl(video.download_addr?.url_list);
	const useMusic = Boolean(musicUrl);

	const captions: DouyinCaptionTrack[] = [];
	const captionInfos = video.cla_info?.caption_infos;
	if (Array.isArray(captionInfos)) {
		for (const info of captionInfos) {
			const url = String(info?.caption_url || info?.url || "");
			if (!url) continue;
			captions.push({ url, lang: String(info?.lang ?? "") });
		}
	}
	const subtitleInfos = video.subtitle_infos;
	if (Array.isArray(subtitleInfos)) {
		for (const info of subtitleInfos) {
			const url = String(info?.url || "");
			if (!url || captions.some((c) => c.url === url)) continue;
			captions.push({
				url,
				lang: String(info?.language_code ?? info?.lang ?? ""),
			});
		}
	}

	return {
		awemeId: String(aweme.aweme_id),
		title: desc.split(/\r?\n/)[0]?.trim() || desc,
		description: desc,
		author: String(aweme.author?.nickname || ""),
		createTimeSec: Number(aweme.create_time) || 0,
		cover:
			firstUrl(video.origin_cover?.url_list) ||
			firstUrl(video.cover?.url_list),
		durationMs: Number(video.duration) || 0,
		// 图集只以 images 数组判定：SSR 数据常缺 play_addr（真实地址由水合
		// XHR 补齐），据 !playUrl 判图集会把普通长视频误判成图集（历史 bug）
		isImageAlbum: Array.isArray(aweme.images) && aweme.images.length > 0,
		captions,
		audioUrl: musicUrl || playUrl,
		audioMime: useMusic ? "audio/mpeg" : "audio/mp4",
		audioExt: useMusic ? "mp3" : "m4a",
		audioSizeBytes:
			Number(musicUrl ? aweme.music?.play_url?.size : video.play_addr?.data_size) ||
			0,
	};
}

/** 评估 aweme 数据完整度（SSR 与桥数据合并时取更全者）。 */
function awemeCompleteness(aweme: any): number {
	if (!aweme) return -1;
	let score = 0;
	if (firstUrl(aweme?.music?.play_url?.url_list)) score += 2;
	if (firstUrl(aweme?.video?.play_addr?.url_list)) score += 2;
	if (
		Array.isArray(aweme?.video?.cla_info?.caption_infos) &&
		aweme.video.cla_info.caption_infos.length
	)
		score += 1;
	if (Number(aweme?.video?.duration) > 0) score += 1;
	return score;
}

/** 选择中文字幕轨，无则取首轨。 */
export function selectDouyinCaptionTrack(
	tracks: DouyinCaptionTrack[],
): DouyinCaptionTrack | null {
	if (!tracks.length) return null;
	return (
		tracks.find((track) => /zh|cn|chi/i.test(track.lang)) || tracks[0]
	);
}

/**
 * 解析 WebVTT 字幕为 cue 列表（纯函数）。
 * 容忍头区 NOTE/STYLE 块、缺省小时段（MM:SS.mmm）、行内标签与时间戳。
 */
export function parseWebVttCues(
	text: string,
): Array<{ from: number; to: number; content: string }> {
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	const cues: Array<{ from: number; to: number; content: string }> = [];
	const timingPattern =
		/^(\d{1,2}:)?(\d{2}):(\d{2})[.,](\d{1,3})\s*-->\s*(\d{1,2}:)?(\d{2}):(\d{2})[.,](\d{1,3})/;
	const parseStamp = (
		h: string | undefined,
		m: string,
		s: string,
		ms: string,
	): number =>
		(Number(h?.replace(":", "")) || 0) * 3600 +
		Number(m) * 60 +
		Number(s) +
		Number(ms.padEnd(3, "0")) / 1000;

	let index = 0;
	while (index < lines.length) {
		const line = lines[index];
		if (!timingPattern.test(line)) {
			index += 1;
			continue;
		}
		const match = line.match(timingPattern)!;
		const from = parseStamp(match[1], match[2], match[3], match[4]);
		const to = parseStamp(match[5], match[6], match[7], match[8]);
		index += 1;
		const textLines: string[] = [];
		while (index < lines.length && lines[index].trim() !== "") {
			textLines.push(lines[index]);
			index += 1;
		}
		const content = textLines
			.join(" ")
			.replace(/<\/?[^>]+>/g, "")
			.replace(/&amp;/g, "&")
			.replace(/&lt;/g, "<")
			.replace(/&gt;/g, ">")
			.replace(/&nbsp;/g, " ")
			.replace(/\s+/g, " ")
			.trim();
		if (content && !/^[♪♫♩♬]+$/.test(content)) {
			cues.push({ from, to, content });
		}
	}
	return cues;
}

export interface DouyinStructuredContent {
	title: string;
	author: string;
	description: string;
	published: string;
	image: string;
	awemeId: string;
	durationSec: number;
	transcript: BilibiliTranscriptCue[];
	subtitleNotice: string;
	transcriptText: string;
	transcriptMarkdown: string;
	structuredHtml: string;
	wordCount: number;
}

/** AI 转写成品缓存的存储键。 */
export function douyinTranscriptCacheKey(awemeId: string): string {
	return `dyTranscript:${awemeId}`;
}

/** "需 AI 转写"标记前缀（剪藏确认无字幕后写入，浮层据此显隐）。 */
export const DOUYIN_TRANSCRIBE_NEED_PREFIX = "dyNeedsTranscribe:";

async function markDouyinTranscribeNeed(
	awemeId: string,
	needed: boolean,
): Promise<void> {
	if (!awemeId) return;
	const key = `${DOUYIN_TRANSCRIBE_NEED_PREFIX}${awemeId}`;
	try {
		if (needed) {
			await browser.storage.local.set({ [key]: Date.now() });
		} else {
			const existing = await browser.storage.local.get(key);
			if (
				!existing ||
				(existing as Record<string, unknown>)[key] === undefined
			) {
				return;
			}
			await browser.storage.local.remove(key);
		}
		window.dispatchEvent(new CustomEvent(TRANSCRIBE_NEED_EVENT));
	} catch {
		// 标记维护失败不影响剪藏主流程
	}
}

interface CachedDouyinTranscript {
	schemaVersion?: number;
	model: string;
	segments?: Array<{ startSec: number; durationSec: number; text: string }>;
	createdAt: number;
}

async function readCachedDouyinTranscript(
	awemeId: string,
): Promise<CachedDouyinTranscript | null> {
	const key = douyinTranscriptCacheKey(awemeId);
	try {
		const bag = (await browser.storage.local.get(key)) as Record<
			string,
			CachedDouyinTranscript
		>;
		return bag?.[key] ?? null;
	} catch {
		return null;
	}
}

async function sendBackgroundMessage(
	message: Record<string, unknown>,
): Promise<any> {
	const response = (await browser.runtime.sendMessage(message)) as {
		success?: boolean;
		error?: string;
	};
	if (!response?.success) {
		throw new Error(response?.error || "background request failed");
	}
	return response;
}

/**
 * 解析当前 aweme 数据：SSR（直达导航）与页面 XHR 拦截桥（SPA 导航/水合）
 * 并取，同一 aweme 时取字段更全者（SSR 常缺 play_addr，桥在 document_start
 * 注册后才有水合数据）；两者皆无时移动端 feed 接口兜底。
 */
async function resolveDouyinAweme(
	doc: Document,
	awemeId?: string,
): Promise<any | null> {
	const ssr = readDouyinSsrAweme(doc);
	const ssrMatched =
		ssr && (!awemeId || String(ssr.aweme_id) === awemeId) ? ssr : null;
	let bridge = null;
	try {
		const resp = await sendBackgroundMessage({
			action: "fetchDouyinBridgeData",
			awemeId,
		});
		bridge = resp?.aweme ?? null;
	} catch (error) {
		logger.warn("Bridge data unavailable", { error: String(error) });
	}
	const bridgeMatched =
		bridge && (!awemeId || String(bridge.aweme_id) === awemeId)
			? bridge
			: null;
	if (ssrMatched && bridgeMatched) {
		return awemeCompleteness(bridgeMatched) > awemeCompleteness(ssrMatched)
			? bridgeMatched
			: ssrMatched;
	}
	if (bridgeMatched) return bridgeMatched;
	if (ssrMatched) return ssrMatched;
	try {
		const resp = await sendBackgroundMessage({
			action: "fetchDouyinFeedApi",
			awemeId: awemeId || "",
		});
		const aweme = resp?.data?.aweme_list?.[0] ?? resp?.data?.aweme_detail;
		if (aweme && (!awemeId || String(aweme.aweme_id) === awemeId)) {
			return aweme;
		}
	} catch (error) {
		logger.warn("Feed api fallback unavailable", {
			error: String(error),
		});
	}
	return null;
}

/**
 * 从 feed 页 DOM 找"当前正在观看"的 aweme id：候选 = 各 feed 条目自带的
 * `/video/{id}` 或 `?aweme_id=`/`?gid=` 链接（虚拟列表中同时存在前后条目），
 * 取视口中心最近者。无法判定时返回 null（上层退回陈列页兜底）。
 */
export function findCurrentFeedAwemeId(doc: Document): string | null {
	const view = doc.defaultView;
	const viewportWidth =
		(view as Window | null)?.innerWidth || globalThis.innerWidth || 1280;
	const viewportHeight =
		(view as Window | null)?.innerHeight || globalThis.innerHeight || 720;
	const candidates: Array<{ id: string; distance: number }> = [];
	for (const el of Array.from(doc.querySelectorAll("a[href]"))) {
		const href = el.getAttribute("href") || "";
		let id = "";
		const pathMatch = href.match(/^\/video\/(\d+)/);
		if (pathMatch) {
			id = pathMatch[1];
		} else {
			try {
				const parsed = new URL(href, "https://www.douyin.com");
				id =
					parsed.searchParams.get("aweme_id") ||
					parsed.searchParams.get("gid") ||
					"";
			} catch {
				continue;
			}
		}
		if (!/^\d+$/.test(id)) continue;
		const rect = (el as HTMLElement).getBoundingClientRect?.();
		if (rect) {
			if (rect.width === 0 && rect.height === 0) continue;
			const centerX = rect.left + rect.width / 2;
			const centerY = rect.top + rect.height / 2;
			if (
				centerY < 0 ||
				centerY > viewportHeight ||
				centerX < 0 ||
				centerX > viewportWidth
			) {
				continue;
			}
			candidates.push({
				id,
				distance: Math.hypot(
					centerX - viewportWidth / 2,
					centerY - viewportHeight / 2,
				),
			});
		} else {
			// 无布局信息（测试环境）：按 DOM 顺序末位近似
			candidates.push({ id, distance: Number.MAX_SAFE_INTEGER - 1 });
		}
	}
	if (!candidates.length) return null;
	candidates.sort((left, right) => left.distance - right.distance);
	return candidates[0].id;
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

export function buildDouyinStructuredHtml(input: {
	description: string;
	transcript: BilibiliTranscriptCue[];
	subtitleNotice?: string;
}): string {
	const sections: string[] = ['<section class="douyin-structured-content">'];
	if (input.description.trim()) {
		sections.push('<section class="douyin-section douyin-description">');
		sections.push("<h2>简介</h2>");
		sections.push(`<p>${escapeHtml(input.description.trim())}</p>`);
		sections.push("</section>");
	}
	if (input.transcript.length) {
		sections.push('<section class="douyin-section douyin-transcript">');
		sections.push("<h2>字幕</h2>");
		sections.push("<ul>");
		input.transcript.forEach((cue) => {
			sections.push(
				`<li><span class="douyin-timestamp">${formatSeconds(
					cue.from,
				)}</span> <span class="douyin-transcript-text">${escapeHtml(
					cue.content,
				)}</span></li>`,
			);
		});
		sections.push("</ul>");
		sections.push("</section>");
	} else if (input.subtitleNotice) {
		sections.push('<section class="douyin-section douyin-subtitle-notice">');
		sections.push(
			`<p class="douyin-subtitle-missing">${escapeHtml(input.subtitleNotice)}</p>`,
		);
		sections.push("</section>");
	}
	sections.push("</section>");
	return sections.join("");
}

function formatSeconds(seconds: number): string {
	const total = Math.max(0, Math.floor(seconds));
	const minutes = Math.floor(total / 60);
	const secs = total % 60;
	return `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function readMetaContent(doc: Document, selector: string): string {
	const element = doc.querySelector(selector) as HTMLMetaElement | null;
	return element?.content?.trim() || "";
}

/** 提取失败时的最小兜底：只用 meta/DOM 数据，保证主体不混入 feed 流。 */
function buildDouyinFallbackContent(
	doc: Document,
	notice: string,
	options?: { keepMetaDescription?: boolean },
): DouyinStructuredContent {
	const title =
		readMetaContent(doc, 'meta[property="og:title"]') ||
		doc.title ||
		"";
	const description = options?.keepMetaDescription
		? readMetaContent(doc, 'meta[name="description"]') || ""
		: "";
	const image = readMetaContent(doc, 'meta[property="og:image"]') || "";
	return {
		title,
		author: "",
		description,
		published: "",
		image,
		awemeId: "",
		durationSec: 0,
		transcript: [],
		subtitleNotice: notice,
		transcriptText: "",
		transcriptMarkdown: "",
		structuredHtml: buildDouyinStructuredHtml({
			description,
			transcript: [],
			subtitleNotice: notice,
		}),
		wordCount: description.split(/\s+/).filter(Boolean).length,
	};
}

/**
 * 从当前文档提取抖音结构化内容。页面分支：
 * - /video/{id}：详情页，完整提取（字幕轨 → AI 转写缓存 → 需转写标记）
 * - feed 页（推荐/关注/发现）：提取当前正在观看的视频（DOM 视口启发式定位）
 * - 其余站内页（用户主页/收藏/搜索等陈列页）：最小兜底，指引打开详情页
 * 所有分支都返回非 null——抖音站内剪藏主体永不回退到 defuddle 全页解析。
 */
export async function extractDouyinStructuredContent(
	doc: Document,
): Promise<DouyinStructuredContent | null> {
	if (!isDouyinSiteUrl(doc.URL)) {
		return null;
	}

	let awemeId = "";
	if (isDouyinVideoUrl(doc.URL)) {
		awemeId = parseDouyinUrl(doc.URL).awemeId || "";
	} else if (isDouyinUserUrl(doc.URL)) {
		// UP 主主页：页内模态播放时提取正在观看的视频（URL 的 modal_id 或
		// 视口启发式定位）；纯网格陈列状态不给提取（无明确主视频）
		if (!hasPlayingDouyinVideo(doc)) {
			return buildDouyinFallbackContent(
				doc,
				"抖音陈列页（主页/收藏/搜索）不支持字幕剪藏：请打开视频详情页后再剪藏",
			);
		}
		try {
			awemeId = new URL(doc.URL).searchParams.get("modal_id") || "";
		} catch {
			awemeId = "";
		}
		if (!awemeId) {
			awemeId = findCurrentFeedAwemeId(doc) || "";
		}
		if (!awemeId) {
			return buildDouyinFallbackContent(
				doc,
				"主页当前播放的视频未能定位：请点击视频标题进入详情页后剪藏",
			);
		}
	} else if (isDouyinFeedUrl(doc.URL)) {
		awemeId = findCurrentFeedAwemeId(doc) || "";
		if (!awemeId) {
			logger.info("Feed page without resolvable current aweme");
			return buildDouyinFallbackContent(
				doc,
				"推荐流当前视频未能定位：请点击视频标题进入详情页后剪藏",
			);
		}
	} else {
		return buildDouyinFallbackContent(
			doc,
			"抖音陈列页（主页/收藏/搜索）不支持字幕剪藏：请打开视频详情页后再剪藏",
		);
	}
	if (!awemeId) {
		return buildDouyinFallbackContent(
			doc,
			"未获取到视频数据：抖音页面数据暂不可读（可能需要登录或稍后重试）",
			{ keepMetaDescription: true },
		);
	}

	const aweme = await resolveDouyinAweme(doc, awemeId);
	if (!aweme) {
		logger.warn("No aweme data from any source", { awemeId });
		return buildDouyinFallbackContent(
			doc,
			"未获取到视频数据：抖音页面数据暂不可读（可能需要登录或稍后重试）",
			{ keepMetaDescription: true },
		);
	}
	const info = extractDouyinAwemeInfo(aweme);
	if (!info || info.awemeId !== awemeId) {
		// 数据与 URL 不一致（桥数据串台）：视为读取失败
		logger.warn("Aweme data mismatch", {
			urlId: awemeId,
			dataId: info?.awemeId,
		});
		return buildDouyinFallbackContent(
			doc,
			"未获取到视频数据：页面数据与当前视频不一致，请稍后重试",
			{ keepMetaDescription: true },
		);
	}

	let transcript: BilibiliTranscriptCue[] = [];
	let subtitleNotice = "";
	let cachedHasFailures = false;
	if (info.isImageAlbum && !info.captions.length) {
		subtitleNotice = "该内容为图集（无视频音轨），不支持字幕剪藏";
	} else {
		const track = selectDouyinCaptionTrack(info.captions);
		if (track) {
			try {
				const resp = await sendBackgroundMessage({
					action: "fetchDouyinCaption",
					url: track.url,
				});
				const cues = parseWebVttCues(String(resp?.text || ""));
				transcript = cues
					.filter((cue) => cue.to > cue.from || cue.content)
					.map((cue) => ({
						from: cue.from,
						to: cue.to,
						content: cue.content,
					}));
			} catch (error) {
				logger.warn("Caption fetch failed", { error: String(error) });
			}
		}
		if (!transcript.length) {
			// 无字幕轨（或字幕轨拉取失败）：回退 AI 转写缓存
			const cached = await readCachedDouyinTranscript(awemeId);
			if (cached?.segments?.length) {
				transcript = cached.segments.flatMap((segment) =>
					splitTextIntoCues(
						segment.text,
						segment.startSec,
						segment.durationSec,
					),
				);
				cachedHasFailures = cached.segments.some((segment) =>
					segment.text.includes("转写失败"),
				);
				subtitleNotice = `以下内容由 AI 语音转写生成（模型 ${cached.model}），可能存在识别误差`;
			} else if (!track) {
				subtitleNotice =
					"未获取到字幕：该视频没有可用字幕轨，可尝试 AI 转写";
			} else {
				subtitleNotice = "未获取到字幕：字幕轨拉取失败，请稍后重试";
			}
		}
	}

	// 无字幕（或缓存为含失败占位的半成品）时置"需转写"标记，浮层按钮据此显示
	await markDouyinTranscribeNeed(
		awemeId,
		(transcript.length === 0 || cachedHasFailures) &&
			!info.isImageAlbum &&
			subtitleNotice !== "",
	);

	const transcriptText = transcript.map((cue) => cue.content).join("\n");
	const published = info.createTimeSec
		? new Date(info.createTimeSec * 1000).toISOString()
		: "";
	// 有真实字幕轨时 notice 为空；AI 转写/缺失原因保留（与 B 站 finalNotice 同语义）
	return {
		title: info.title || doc.title,
		author: info.author,
		description: info.description,
		published,
		image: info.cover,
		awemeId,
		durationSec: Math.round(info.durationMs / 1000),
		transcript,
		subtitleNotice,
		transcriptText,
		transcriptMarkdown: buildBilibiliTranscriptMarkdown(transcript, []),
		structuredHtml: buildDouyinStructuredHtml({
			description: info.description,
			transcript,
			subtitleNotice,
		}),
		wordCount: `${info.description}\n${transcriptText}`
			.trim()
			.split(/\s+/)
			.filter(Boolean).length,
	};
}

/**
 * 响应 background 的转写元数据请求：当前视频的音频地址与热词原料。
 * 音频选原声轨（music.play_url）优先——体积小且通常含完整人声。
 */
export async function collectDouyinAwemeAudio(
	doc: Document,
	awemeId: string,
): Promise<{
	awemeId: string;
	audioUrl: string;
	audioMime: string;
	audioExt: string;
	sizeBytes: number;
	durationSec: number;
	promptParts: string[];
} | null> {
	const aweme = await resolveDouyinAweme(doc, awemeId);
	const info = aweme ? extractDouyinAwemeInfo(aweme) : null;
	if (!info) return null;
	return {
		awemeId: info.awemeId,
		audioUrl: info.audioUrl,
		audioMime: info.audioMime,
		audioExt: info.audioExt,
		sizeBytes: info.audioSizeBytes,
		durationSec: info.durationMs / 1000,
		promptParts: [info.title, info.author, info.description.slice(0, 200)],
	};
}
