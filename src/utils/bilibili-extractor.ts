import browser from "./browser-polyfill";
import { createLogger } from "./logger";
import { getWbiKeys, signWbiQuery } from "./bilibili-wbi";

const logger = createLogger("Bilibili");

export interface BilibiliParsedUrl {
	bvid: string | null;
	aid: number | null;
	page: number;
	hasExplicitPageParam: boolean;
}

export interface BilibiliChapter {
	title: string;
	from: number;
	to?: number;
}

export interface BilibiliTranscriptCue {
	from: number;
	to: number;
	content: string;
}

export interface BilibiliResolvedPage {
	cid: number;
	page: number;
	part: string;
	duration: number;
}

export interface BilibiliStructuredContent {
	title: string;
	author: string;
	description: string;
	published: string;
	image: string;
	bvid: string;
	aid: number | null;
	cid: number;
	page: number;
	chapters: BilibiliChapter[];
	transcript: BilibiliTranscriptCue[];
	/** 字幕缺失时的原因说明，空串表示字幕正常。 */
	subtitleNotice: string;
	transcriptText: string;
	transcriptMarkdown: string;
	chaptersMarkdown: string;
	structuredHtml: string;
	wordCount: number;
}

interface BilibiliViewPage {
	page?: number;
	cid?: number;
	duration?: number;
	part?: string;
}

interface BilibiliViewData {
	aid?: number;
	bvid?: string;
	title?: string;
	desc?: string;
	pubdate?: number;
	pic?: string;
	owner?: {
		name?: string;
	};
	cid?: number;
	duration?: number;
	pages?: BilibiliViewPage[];
}

interface BilibiliSubtitleTrack {
	id?: number;
	lan?: string;
	lan_doc?: string;
	subtitle_url?: string;
	is_ai_subtitle?: boolean;
}

interface BilibiliPlayerData {
	/** 登录用户 mid，匿名请求为空或 0，用于判断登录态是否生效。 */
	login_mid?: number;
	subtitle?: {
		subtitles?: BilibiliSubtitleTrack[];
	};
	view_points?: Array<{
		content?: string;
		from?: number;
		to?: number;
	}>;
}

interface BilibiliSubtitleResponse {
	body?: Array<{
		from?: number;
		to?: number;
		content?: string;
	}>;
}

/**
 * 判断 URL 是否为 B 站视频页。
 */
export function isBilibiliVideoUrl(url: string): boolean {
	try {
		const parsedUrl = new URL(url);
		return (
			parsedUrl.hostname.includes("bilibili.com") &&
			/^\/video\/(BV[\w]+|av\d+)/i.test(parsedUrl.pathname)
		);
	} catch {
		return false;
	}
}

/**
 * 解析 B 站视频 URL 中的 bvid/aid 与分 P。
 */
export function parseBilibiliUrl(url: string): BilibiliParsedUrl {
	try {
		const parsedUrl = new URL(url);
		const match = parsedUrl.pathname.match(/^\/video\/(BV[\w]+|av\d+)/i);
		const rawVideoId = match?.[1] || "";
		const pageParam = parsedUrl.searchParams.get("p");
		const page = Number.parseInt(pageParam || "1", 10);
		return {
			bvid: /^BV/i.test(rawVideoId) ? rawVideoId : null,
			aid: /^av/i.test(rawVideoId)
				? Number.parseInt(rawVideoId.slice(2), 10)
				: null,
			page: Number.isFinite(page) && page > 0 ? page : 1,
			hasExplicitPageParam: parsedUrl.searchParams.has("p"),
		};
	} catch {
		return {
			bvid: null,
			aid: null,
			page: 1,
			hasExplicitPageParam: false,
		};
	}
}

/**
 * 从 view 接口数据中解析当前分 P 的 cid。
 */
export function resolveBilibiliPage(
	viewData: BilibiliViewData,
	page: number,
): BilibiliResolvedPage | null {
	const pages = Array.isArray(viewData.pages) ? viewData.pages : [];
	const matchedPage =
		pages.find((item) => item.page === page) || pages[page - 1];
	const cid = matchedPage?.cid ?? viewData.cid;
	if (!cid) {
		return null;
	}

	return {
		cid,
		page: matchedPage?.page ?? page,
		part: matchedPage?.part || "",
		duration: matchedPage?.duration ?? viewData.duration ?? 0,
	};
}

/**
 * 规范化字幕 URL，处理协议相对地址。
 */
export function normalizeBilibiliSubtitleUrl(url: string): string {
	if (!url) return "";
	if (url.startsWith("//")) {
		return `https:${url}`;
	}
	return url;
}

/**
 * 将秒数格式化为 `mm:ss` 或 `hh:mm:ss`。
 */
export function formatBilibiliTimestamp(seconds: number): string {
	const totalSeconds = Math.max(0, Math.floor(seconds));
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const secs = totalSeconds % 60;

	if (hours > 0) {
		return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
	}
	return `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

/**
 * 生成章节 Markdown。
 */
export function buildBilibiliChaptersMarkdown(
	chapters: BilibiliChapter[],
): string {
	return chapters
		.map(
			(chapter) =>
				`- \`${formatBilibiliTimestamp(chapter.from)}\` ${chapter.title}`,
		)
		.join("\n");
}

/**
 * 将字幕按章节分组后输出 Markdown。
 */
export function buildBilibiliTranscriptMarkdown(
	transcript: BilibiliTranscriptCue[],
	chapters: BilibiliChapter[],
): string {
	if (!transcript.length) return "";

	return groupTranscriptByChapters(transcript, chapters)
		.map((group) => {
			const heading = group.title ? `### ${group.title}\n\n` : "";
			const lines = group.lines
				.map(
					(cue) =>
						`- \`${formatBilibiliTimestamp(cue.from)}\` ${cue.content}`,
				)
				.join("\n");
			return `${heading}${lines}`.trim();
		})
		.join("\n\n");
}

/**
 * 构建 B 站结构化 HTML，避免混入推荐区和评论区等无关元素。
 */
export function buildBilibiliStructuredHtml(input: {
	description: string;
	chapters: BilibiliChapter[];
	transcript: BilibiliTranscriptCue[];
	subtitleNotice?: string;
}): string {
	const sections: string[] = [
		'<section class="bilibili-structured-content">',
	];

	if (input.description.trim()) {
		sections.push(
			'<section class="bilibili-section bilibili-description">',
		);
		sections.push("<h2>简介</h2>");
		sections.push(`<p>${escapeHtml(input.description.trim())}</p>`);
		sections.push("</section>");
	}

	if (input.chapters.length) {
		sections.push('<section class="bilibili-section bilibili-chapters">');
		sections.push("<h2>章节</h2>");
		sections.push("<ol>");
		input.chapters.forEach((chapter) => {
			sections.push(
				`<li><span class="bilibili-timestamp" data-time="${Math.floor(chapter.from)}">${formatBilibiliTimestamp(chapter.from)}</span> <span class="bilibili-chapter-title">${escapeHtml(chapter.title)}</span></li>`,
			);
		});
		sections.push("</ol>");
		sections.push("</section>");
	}

	if (input.transcript.length) {
		sections.push('<section class="bilibili-section bilibili-transcript">');
		sections.push("<h2>字幕</h2>");

		const groupedTranscript = groupTranscriptByChapters(
			input.transcript,
			input.chapters,
		);
		groupedTranscript.forEach((group) => {
			if (group.title) {
				sections.push(`<h3>${escapeHtml(group.title)}</h3>`);
			}
			sections.push("<ul>");
			group.lines.forEach((cue) => {
				sections.push(
					`<li><span class="bilibili-timestamp" data-time="${Math.floor(cue.from)}">${formatBilibiliTimestamp(cue.from)}</span> <span class="bilibili-transcript-text">${escapeHtml(cue.content)}</span></li>`,
				);
			});
			sections.push("</ul>");
		});

		sections.push("</section>");
	} else if (input.subtitleNotice) {
		sections.push(
			'<section class="bilibili-section bilibili-subtitle-notice">',
		);
		sections.push(
			`<p class="bilibili-subtitle-missing">${escapeHtml(input.subtitleNotice)}</p>`,
		);
		sections.push("</section>");
	}

	sections.push("</section>");
	return sections.join("");
}

/**
 * 从当前文档提取 B 站结构化内容。
 */
export async function extractBilibiliStructuredContent(
	doc: Document,
): Promise<BilibiliStructuredContent | null> {
	if (!isBilibiliVideoUrl(doc.URL)) {
		return null;
	}

	const parsedUrl = parseBilibiliUrl(doc.URL);
	if (!parsedUrl.bvid && !parsedUrl.aid) {
		return null;
	}

	const viewUrl = new URL("https://api.bilibili.com/x/web-interface/view");
	if (parsedUrl.bvid) {
		viewUrl.searchParams.set("bvid", parsedUrl.bvid);
	}
	if (parsedUrl.aid) {
		viewUrl.searchParams.set("aid", String(parsedUrl.aid));
	}

	const viewResponse = await fetchBilibiliJson(viewUrl.toString());
	const viewData = viewResponse?.data as BilibiliViewData | undefined;
	if (!viewData) {
		logger.warn("View API returned no data", { url: viewUrl.toString() });
		return null;
	}

	const resolvedPage = resolveBilibiliPage(viewData, parsedUrl.page);
	if (!resolvedPage) {
		logger.warn("Failed to resolve page", {
			bvid: viewData.bvid,
			requestedPage: parsedUrl.page,
		});
		return null;
	}

	const { playerData, loginEffective, subtitleStable } =
		await fetchBilibiliPlayerData({
			aid: viewData.aid ?? parsedUrl.aid,
			bvid: viewData.bvid ?? parsedUrl.bvid,
			cid: resolvedPage.cid,
		});

	const chapters = normalizeBilibiliChapters(playerData?.view_points || []);
	const selectedTrack = selectBilibiliSubtitleTrack(
		playerData?.subtitle?.subtitles || [],
	);
	// 字幕文件拉取失败时降级为无字幕，避免整个提取失败丢掉简介与章节。
	let subtitleData: BilibiliSubtitleResponse | null = null;
	if (selectedTrack?.subtitle_url) {
		try {
			subtitleData = (await fetchBilibiliJson(
				normalizeBilibiliSubtitleUrl(selectedTrack.subtitle_url),
			)) as BilibiliSubtitleResponse;
		} catch (error) {
			logger.warn("Subtitle file fetch failed", {
				url: selectedTrack.subtitle_url,
				error: String(error),
			});
		}
	}
	let transcript = normalizeBilibiliTranscript(subtitleData?.body || []);
	let transcriptImplausible = false;
	if (
		transcript.length > 0 &&
		!isTranscriptPlausible(transcript, resolvedPage.duration)
	) {
		logger.warn("Discarded implausible transcript", {
			videoDuration: resolvedPage.duration,
			lastCueFrom: transcript[transcript.length - 1].from,
			cueCount: transcript.length,
		});
		transcript = [];
		transcriptImplausible = true;
	}
	const subtitleNotice = buildSubtitleNotice(
		playerData,
		selectedTrack,
		transcript.length,
		loginEffective,
		subtitleStable,
		transcriptImplausible,
	);
	// 无可信字幕轨时回退 AI 转写缓存（由 background 转写任务生成）
	let finalNotice = subtitleNotice;
	if (!transcript.length) {
		const cached = await readCachedTranscript(
			viewData.bvid || parsedUrl.bvid || "",
			resolvedPage.cid,
		);
		if (cached?.chunks?.length) {
			transcript = cached.chunks
				.map((chunk) => ({
					from: chunk.startSec,
					to: chunk.startSec + 600,
					content: chunk.text,
				}))
				.filter((cue) => cue.content.trim().length > 0);
			finalNotice = `以下内容由 AI 语音转写生成（模型 ${cached.model}），可能存在识别误差`;
		}
	}
	const transcriptText = transcript.map((cue) => cue.content).join("\n");
	const transcriptMarkdown = buildBilibiliTranscriptMarkdown(
		transcript,
		chapters,
	);
	const chaptersMarkdown = buildBilibiliChaptersMarkdown(chapters);
	const description =
		viewData.desc || readMetaContent(doc, 'meta[name="description"]') || "";
	const title =
		viewData.title ||
		readMetaContent(doc, 'meta[property="og:title"]') ||
		doc.title ||
		"";
	const image =
		viewData.pic || readMetaContent(doc, 'meta[property="og:image"]') || "";
	const author =
		viewData.owner?.name ||
		readTextContent(doc, ".up-name") ||
		readTextContent(doc, "[data-user-name]") ||
		"";
	const published = viewData.pubdate
		? new Date(viewData.pubdate * 1000).toISOString()
		: "";
	const structuredHtml = buildBilibiliStructuredHtml({
		description,
		chapters,
		transcript,
		subtitleNotice: finalNotice,
	});
	const wordCount = `${description}\n${transcriptText}`
		.trim()
		.split(/\s+/)
		.filter(Boolean).length;

	logger.info("Extraction complete", {
		bvid: viewData.bvid,
		chapters: chapters.length,
		transcriptCues: transcript.length,
		subtitleTrack: selectedTrack?.lan_doc ?? "none",
	});

	return {
		title,
		author,
		description,
		published,
		image,
		bvid: viewData.bvid || parsedUrl.bvid || "",
		aid: viewData.aid ?? parsedUrl.aid,
		cid: resolvedPage.cid,
		page: resolvedPage.page,
		chapters,
		transcript,
		subtitleNotice: finalNotice,
		transcriptText,
		transcriptMarkdown,
		chaptersMarkdown,
		structuredHtml,
		wordCount,
	};
}

interface CachedTranscript {
	model: string;
	chunks: Array<{ startSec: number; text: string }>;
	createdAt: number;
}

/** AI 转写成品缓存的存储键（写读两侧统一使用）。 */
export function transcriptCacheKey(bvid: string, cid: number): string {
	return `biliTranscript:${bvid}:${cid}`;
}

/**
 * 读取 AI 转写成品缓存（background 转写任务写入 chrome.storage.local）。
 */
export async function readCachedTranscript(
	bvid: string,
	cid: number,
): Promise<CachedTranscript | null> {
	if (!bvid || !cid) return null;
	const key = transcriptCacheKey(bvid, cid);
	try {
		const bag = (await browser.storage.local.get(key)) as Record<
			string,
			CachedTranscript
		>;
		return bag?.[key] ?? null;
	} catch {
		return null;
	}
}

/**
 * 通过 background 代理抓取 B 站 JSON，避免内容脚本直接跨域请求失败。
 */
async function fetchBilibiliJson(url: string): Promise<any> {
	const response = (await browser.runtime.sendMessage({
		action: "fetchBilibiliJson",
		url,
	})) as { success?: boolean; data?: any; error?: string };

	if (!response?.success) {
		throw new Error(response?.error || "Failed to fetch Bilibili data");
	}

	return response.data;
}

async function fetchBilibiliJsonViaMainWorld(url: string): Promise<any> {
	const response = (await browser.runtime.sendMessage({
		action: "fetchBilibiliJsonViaMainWorld",
		url,
	})) as { success?: boolean; data?: any; error?: string };

	if (!response?.success) {
		throw new Error(
			response?.error || "Failed to fetch Bilibili data via page context",
		);
	}

	return response.data;
}

/**
 * 借登录态抓取 B 站 JSON：MV3 扩展发起的请求带不上 SameSite cookie，
 * 由 background 用 DNR 注入 Cookie 头完成（仅 Chrome 系）。
 */
async function fetchBilibiliJsonWithCookies(url: string): Promise<any> {
	const response = (await browser.runtime.sendMessage({
		action: "fetchBilibiliJsonWithCookies",
		url,
	})) as { success?: boolean; data?: any; error?: string };

	if (!response?.success) {
		throw new Error(
			response?.error || "Failed to fetch Bilibili data with cookies",
		);
	}

	return response.data;
}

interface BilibiliPlayerFetchResult {
	playerData: BilibiliPlayerData | null;
	/** cookie 注入或页面上下文返回的数据是否携带登录身份（login_mid > 0）。 */
	loginEffective: boolean;
	/** 字幕轨双重采样是否稳定：false 表示接口风控抖动，轨列表已被清空。 */
	subtitleStable: boolean;
}

function fingerprintSubtitleTracks(data: BilibiliPlayerData | null): string {
	return JSON.stringify(
		(data?.subtitle?.subtitles || [])
			.map((track) => `${track.lan}|${track.subtitle_url || ""}`)
			.sort(),
	);
}

/** 返回去掉字幕轨的浅拷贝，用于风控抖动时丢弃不可信轨。 */
function stripSubtitleTracks(data: BilibiliPlayerData): BilibiliPlayerData {
	return { ...data, subtitle: { ...data.subtitle, subtitles: [] } };
}

/**
 * B 站字幕接口存在风控钓鱼：同一视频随机返回空轨或指向无关视频的字幕轨。
 * 拿到轨后用同一通道重放一次，两次轨集合不一致即判定为不可信。
 */
async function verifySubtitleTracksStable(
	fetchVia: (url: string) => Promise<any>,
	url: string,
	data: BilibiliPlayerData,
): Promise<boolean> {
	try {
		const replay = await fetchVia(url);
		const replayData = replay?.data as BilibiliPlayerData | undefined;
		if (!replayData) return true;
		return (
			fingerprintSubtitleTracks(replayData) ===
			fingerprintSubtitleTracks(data)
		);
	} catch {
		return true;
	}
}

/**
 * 拉取播放器接口数据：匿名请求 → 登录态（cookie 注入）→ 页面上下文，三级回退。
 */
async function fetchBilibiliPlayerData(input: {
	aid: number | null | undefined;
	bvid: string | null | undefined;
	cid: number;
}): Promise<BilibiliPlayerFetchResult> {
	const v2Url = new URL("https://api.bilibili.com/x/player/v2");
	v2Url.searchParams.set("cid", String(input.cid));
	if (input.bvid) {
		v2Url.searchParams.set("bvid", input.bvid);
	}
	if (input.aid) {
		v2Url.searchParams.set("aid", String(input.aid));
	}
	const v2UrlString = v2Url.toString();

	// 第一级：匿名请求（wbi/v2 签名版优先，v2 兜底）。UP 主上传的公开字幕
	// 匿名即可见，多数视频在此拿到数据。
	let anonymousData: BilibiliPlayerData | null = null;
	let anonymousUrl = "";
	const urls: string[] = [];

	if (input.aid && input.bvid) {
		const wbiKeys = await getWbiKeys(fetchBilibiliJson).catch(() => null);
		if (wbiKeys) {
			const signedQuery = signWbiQuery(
				{
					aid: String(input.aid),
					bvid: input.bvid,
					cid: String(input.cid),
				},
				wbiKeys,
			);
			urls.push(
				`https://api.bilibili.com/x/player/wbi/v2?${signedQuery}`,
			);
		}
	}
	urls.push(v2UrlString);

	for (const url of urls) {
		try {
			const data = await fetchBilibiliJson(url);
			if (data?.data) {
				anonymousData = data.data as BilibiliPlayerData;
				anonymousUrl = url;
				break;
			}
		} catch {
			// Try next endpoint.
		}
	}

	const anonymousSubtitleCount =
		anonymousData?.subtitle?.subtitles?.length || 0;
	if (anonymousSubtitleCount > 0) {
		const stable = await verifySubtitleTracksStable(
			fetchBilibiliJson,
			anonymousUrl,
			anonymousData!,
		);
		return stable
			? {
					playerData: anonymousData,
					loginEffective: false,
					subtitleStable: true,
				}
			: {
					playerData: stripSubtitleTracks(anonymousData!),
					loginEffective: false,
					subtitleStable: false,
				};
	}

	// 第二级：DNR 注入登录 cookie 重试。固定用 v2 端点（实测 wbi/v2 对注入
	// cookie 仍按匿名处理，v2 + cookie 可取回 AI 字幕轨）。AI 字幕需要登录态。
	try {
		const sessionData = await fetchBilibiliJsonWithCookies(v2UrlString);
		const sessionPlayerData = sessionData?.data as
			BilibiliPlayerData | undefined;
		if (sessionPlayerData) {
			const loginEffective = (sessionPlayerData.login_mid ?? 0) > 0;
			const sessionSubtitleCount =
				sessionPlayerData.subtitle?.subtitles?.length || 0;
			if (sessionSubtitleCount > 0) {
				const stable = await verifySubtitleTracksStable(
					fetchBilibiliJsonWithCookies,
					v2UrlString,
					sessionPlayerData,
				);
				return stable
					? {
							playerData: sessionPlayerData,
							loginEffective,
							subtitleStable: true,
						}
					: {
							playerData: stripSubtitleTracks(sessionPlayerData),
							loginEffective,
							subtitleStable: false,
						};
			}
			// 登录态下依然无字幕轨——视频确实没有字幕，用登录态数据（含章节）即可
			return {
				playerData: sessionPlayerData,
				loginEffective,
				subtitleStable: true,
			};
		}
	} catch (error) {
		logger.warn("Cookie-injected player fetch failed", {
			url: v2UrlString,
			error: String(error),
		});
	}

	// 第三级：页面上下文兜底（非 Chromium 浏览器）。页面上下文自带登录 cookie。
	try {
		const pageContextData =
			await fetchBilibiliJsonViaMainWorld(v2UrlString);
		const pageContextPlayerData = pageContextData?.data as
			BilibiliPlayerData | undefined;
		const pageContextSubtitleCount =
			pageContextPlayerData?.subtitle?.subtitles?.length || 0;
		if (pageContextSubtitleCount > 0) {
			const stable = await verifySubtitleTracksStable(
				fetchBilibiliJsonViaMainWorld,
				v2UrlString,
				pageContextPlayerData!,
			);
			return stable
				? {
						playerData: pageContextPlayerData ?? null,
						loginEffective:
							(pageContextPlayerData?.login_mid ?? 0) > 0,
						subtitleStable: true,
					}
				: {
						playerData: stripSubtitleTracks(pageContextPlayerData!),
						loginEffective:
							(pageContextPlayerData?.login_mid ?? 0) > 0,
						subtitleStable: false,
					};
		}
	} catch (error) {
		logger.warn("Page-context player fetch failed", {
			url: v2UrlString,
			error: String(error),
		});
	}

	return {
		playerData: anonymousData,
		loginEffective: false,
		subtitleStable: true,
	};
}

/**
 * 字幕缺失时给出可读原因，避免静默空白。
 */
function buildSubtitleNotice(
	playerData: BilibiliPlayerData | null,
	selectedTrack: BilibiliSubtitleTrack | null,
	transcriptLength: number,
	loginEffective: boolean,
	subtitleStable: boolean,
	transcriptImplausible: boolean,
): string {
	if (transcriptLength > 0) {
		return "";
	}
	if (transcriptImplausible) {
		return "未获取到字幕：接口返回的字幕与视频时长严重不符（疑似风控无效数据），已忽略，请稍后重试";
	}
	if (!subtitleStable) {
		return "未获取到字幕：B 站接口本次返回的字幕轨不稳定（疑似风控），已忽略，请稍后重试";
	}
	if (!playerData) {
		return "未获取到字幕：播放器接口请求失败（网络异常或接口受限）";
	}
	if (!selectedTrack) {
		return loginEffective
			? "未获取到字幕：该视频没有可用字幕（UP 未上传 CC 字幕，B 站也未生成 AI 字幕）"
			: "未获取到字幕：该视频可能没有可用字幕；AI 字幕需要登录 B 站账号后重试";
	}
	return "未获取到字幕：字幕内容拉取失败或仅含音乐标记，请稍后重试";
}

/**
 * 章节数据标准化。
 */
function normalizeBilibiliChapters(
	viewPoints: Array<{ content?: string; from?: number; to?: number }>,
): BilibiliChapter[] {
	return viewPoints
		.filter(
			(item) =>
				typeof item.content === "string" &&
				typeof item.from === "number",
		)
		.map((item) => ({
			title: item.content!.trim(),
			from: item.from!,
			to: item.to,
		}))
		.filter((item) => item.title.length > 0);
}

/**
 * B 站以 ♪ 等音乐符号标注 BGM 歌词转写，不属于语音内容。
 */
const MUSIC_CUE_PATTERN = /^[♪♫♩♬]/;

/**
 * 校验字幕覆盖时长与视频时长的匹配度。B 站风控返回的假字幕来自其他视频，
 * 覆盖时长与本视频严重不符；真字幕（CC/AI 转写）总是覆盖全片。
 * 字幕末条时间戳落在视频时长的 50%~150% 区间外即判定不可信。
 * 60 秒以下的短视频豁免（字幕稀疏时易误判）。
 */
function isTranscriptPlausible(
	transcript: BilibiliTranscriptCue[],
	videoDuration: number,
): boolean {
	if (transcript.length === 0 || videoDuration < 60) return true;
	const lastFrom = transcript[transcript.length - 1].from;
	return lastFrom >= videoDuration * 0.5 && lastFrom <= videoDuration * 1.5;
}

/**
 * 字幕数据标准化。
 */
function normalizeBilibiliTranscript(
	body: Array<{ from?: number; to?: number; content?: string }>,
): BilibiliTranscriptCue[] {
	return body
		.filter(
			(item) =>
				typeof item.from === "number" &&
				typeof item.to === "number" &&
				typeof item.content === "string",
		)
		.map((item) => ({
			from: item.from!,
			to: item.to!,
			content: item.content!.replace(/\s+/g, " ").trim(),
		}))
		.filter(
			(item) =>
				item.content.length > 0 &&
				!MUSIC_CUE_PATTERN.test(item.content),
		);
}

/**
 * 根据语言优先级选择最合适的字幕轨。
 */
function selectBilibiliSubtitleTrack(
	tracks: BilibiliSubtitleTrack[],
): BilibiliSubtitleTrack | null {
	if (!tracks.length) return null;

	const scoreTrack = (track: BilibiliSubtitleTrack): number => {
		const language =
			`${track.lan || ""} ${track.lan_doc || ""}`.toLowerCase();
		if (
			language.includes("zh-cn") ||
			language.includes("中文") ||
			language.includes("汉语")
		)
			return 5;
		if (language.includes("zh-hans") || language.includes("简体")) return 4;
		if (language.includes("zh")) return 3;
		if (language.includes("en") || language.includes("english")) return 2;
		return 1;
	};

	return (
		[...tracks].sort(
			(left, right) => scoreTrack(right) - scoreTrack(left),
		)[0] || null
	);
}

function groupTranscriptByChapters(
	transcript: BilibiliTranscriptCue[],
	chapters: BilibiliChapter[],
): Array<{ title?: string; lines: BilibiliTranscriptCue[] }> {
	if (!chapters.length) {
		return [{ lines: transcript }];
	}

	const groups = chapters
		.map((chapter) => ({
			title: chapter.title,
			lines: transcript.filter(
				(cue) =>
					cue.from >= chapter.from &&
					cue.from < (chapter.to ?? Number.POSITIVE_INFINITY),
			),
		}))
		.filter((group) => group.lines.length > 0);

	const groupedLines = new Set(groups.flatMap((group) => group.lines));
	const leftovers = transcript.filter((cue) => !groupedLines.has(cue));
	if (leftovers.length) {
		groups.push({
			title: "其他片段",
			lines: leftovers,
		});
	}

	return groups;
}

function readMetaContent(doc: Document, selector: string): string {
	const element = doc.querySelector(selector) as HTMLMetaElement | null;
	return element?.content?.trim() || "";
}

function readTextContent(doc: Document, selector: string): string {
	return doc.querySelector(selector)?.textContent?.trim() || "";
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}
