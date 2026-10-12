import { describe, expect, test, vi } from "vitest";
import { parseHTML } from "linkedom";

vi.mock("./browser-polyfill", () => ({
	default: {
		runtime: {
			sendMessage: vi.fn(),
		},
	},
}));

import {
	collectDouyinAwemeAudio,
	extractDouyinAwemeInfo,
	extractDouyinStructuredContent,
	findAwemeInDouyinSsr,
	findCurrentFeedAwemeId,
	isDouyinFeedUrl,
	isDouyinSiteUrl,
	isDouyinVideoUrl,
	parseDouyinUrl,
	parseWebVttCues,
	selectDouyinCaptionTrack,
} from "./douyin-extractor";
import browser from "./browser-polyfill";

const AWEME = {
	aweme_id: "7301234567890",
	desc: "标题行\n第二行简介 #健身",
	create_time: 1716200000,
	author: { nickname: "测试作者" },
	images: null,
	media_type: 0,
	video: {
		duration: 90000,
		origin_cover: { url_list: ["https://p3.douyinpic.com/cover.jpeg"] },
		play_addr: {
			url_list: ["https://www.douyin.com/aweme/v1/play/?video_id=x"],
			data_size: 5000000,
		},
		cla_info: {
			caption_infos: [
				{ caption_url: "https://v3-web.douyinvod.com/caption.vtt", lang: "zh" },
			],
		},
	},
	music: {
		play_url: {
			url_list: ["https://v3-web.douyinvod.com/orig.mp3"],
			size: 900000,
		},
	},
};

describe("douyin url 判定", () => {
	test("仅 /video/{id} 详情页纳入剪藏", () => {
		expect(isDouyinVideoUrl("https://www.douyin.com/video/7301234567890")).toBe(
			true,
		);
		expect(isDouyinVideoUrl("https://www.douyin.com/video/7301234567890?a=1")).toBe(
			true,
		);
		// feed / 搜索 / 用户主页 / 图集 / 弹层：一律排除
		expect(isDouyinVideoUrl("https://www.douyin.com/?recommend=1")).toBe(false);
		expect(isDouyinVideoUrl("https://www.douyin.com/follow")).toBe(false);
		expect(isDouyinVideoUrl("https://www.douyin.com/search/健身")).toBe(false);
		expect(
			isDouyinVideoUrl("https://www.douyin.com/user/MS4wLjABAAA_x"),
		).toBe(false);
		expect(isDouyinVideoUrl("https://www.douyin.com/note/7301")).toBe(false);
		expect(isDouyinVideoUrl("https://www.bilibili.com/video/BV1x")).toBe(false);
	});

	test("站点判定覆盖所有 douyin 子域（桥注入用）", () => {
		expect(isDouyinSiteUrl("https://www.douyin.com/?recommend=1")).toBe(true);
		expect(isDouyinSiteUrl("https://live.douyin.com/123")).toBe(true);
		expect(isDouyinSiteUrl("https://www.bilibili.com/")).toBe(false);
	});

	test("parses awemeId", () => {
		expect(parseDouyinUrl("https://www.douyin.com/video/7301?f=1")).toEqual({
			awemeId: "7301",
		});
	});
});

describe("findAwemeInDouyinSsr", () => {
	test("probes app.videoInfoRes path", () => {
		const data = { app: { videoInfoRes: { item_list: [AWEME] } } };
		expect(findAwemeInDouyinSsr(data)?.aweme_id).toBe(AWEME.aweme_id);
	});

	test("probes loaderData variants", () => {
		const data = {
			loaderData: {
				"video_(id)/page": { videoInfoRes: { item_list: [AWEME] } },
			},
		};
		expect(findAwemeInDouyinSsr(data)?.aweme_id).toBe(AWEME.aweme_id);
	});

	test("returns null when no candidate carries aweme_id", () => {
		expect(findAwemeInDouyinSsr({ app: { videoInfoRes: {} } })).toBeNull();
		expect(findAwemeInDouyinSsr(null)).toBeNull();
	});
});

describe("extractDouyinAwemeInfo", () => {
	test("normalizes aweme fields, prefers original sound", () => {
		const info = extractDouyinAwemeInfo(AWEME)!;
		expect(info.awemeId).toBe("7301234567890");
		expect(info.title).toBe("标题行");
		expect(info.description).toContain("第二行简介");
		expect(info.author).toBe("测试作者");
		expect(info.durationMs).toBe(90000);
		expect(info.audioUrl).toBe("https://v3-web.douyinvod.com/orig.mp3");
		expect(info.audioMime).toBe("audio/mpeg");
		expect(info.captions).toEqual([
			{ url: "https://v3-web.douyinvod.com/caption.vtt", lang: "zh" },
		]);
		expect(info.isImageAlbum).toBe(false);
	});

	test("falls back to play_addr when music track missing", () => {
		const aweme = JSON.parse(JSON.stringify(AWEME));
		aweme.music = {};
		const info = extractDouyinAwemeInfo(aweme)!;
		expect(info.audioUrl).toContain("/aweme/v1/play/");
		expect(info.audioMime).toBe("audio/mp4");
	});

	test("detects image albums", () => {
		const aweme = JSON.parse(JSON.stringify(AWEME));
		aweme.images = [{}, {}];
		expect(extractDouyinAwemeInfo(aweme)!.isImageAlbum).toBe(true);
	});

	test("missing play_addr (SSR 数据不全) is NOT an image album", () => {
		// 历史 bug：直入 /video 页时 SSR 常缺 play_addr（由水合 XHR 补齐），
		// 据此判图集会把 15 分钟普通视频误判成图集
		const aweme = JSON.parse(JSON.stringify(AWEME));
		aweme.video.play_addr = {};
		aweme.music = {};
		expect(extractDouyinAwemeInfo(aweme)!.isImageAlbum).toBe(false);
	});
});

describe("selectDouyinCaptionTrack", () => {
	test("prefers zh track", () => {
		const tracks = [
			{ url: "https://x/en.vtt", lang: "en" },
			{ url: "https://x/zh.vtt", lang: "zh" },
		];
		expect(selectDouyinCaptionTrack(tracks)?.url).toBe("https://x/zh.vtt");
		expect(selectDouyinCaptionTrack([])).toBeNull();
	});
});

describe("parseWebVttCues", () => {
	test("parses cues, strips tags, skips music-only lines", () => {
		const vtt = [
			"WEBVTT",
			"",
			"NOTE 这是一个注释块",
			"跨行注释",
			"",
			"1",
			"00:00:00.640 --> 00:00:02.120",
			"大家好<c.bg>今天</c>讲一下",
			"",
			"00:15.000 --> 00:17.500",
			"♪",
			"",
			"00:20.000 --> 00:22.000",
			"第二句 &amp; 转义",
		].join("\n");
		const cues = parseWebVttCues(vtt);
		expect(cues).toHaveLength(2);
		expect(cues[0]).toEqual({
			from: 0.64,
			to: 2.12,
			content: "大家好今天讲一下",
		});
		// 无小时段按 MM:SS.mmm 解析
		expect(cues[1].from).toBe(20);
		expect(cues[1].content).toBe("第二句 & 转义");
	});
});

function makeDoc(url: string, ssrData?: unknown) {
	const ssrScript = ssrData
		? `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">${JSON.stringify(ssrData)}</script>`
		: "";
	const { document: doc } = parseHTML(
		`<html><head><title>Douyin</title>${ssrScript}</head><body></body></html>`,
	);
	Object.defineProperty(doc, "URL", { value: url, configurable: true });
	return doc as unknown as Document;
}

function setupStorage(storageData: Map<string, any>) {
	const written = new Set<string>();
	const removed = new Set<string>();
	(browser as any).storage = {
		local: {
			get: async (k: string) =>
				storageData.has(k) ? { [k]: storageData.get(k) } : {},
			set: async (kv: Record<string, any>) => {
				for (const key of Object.keys(kv)) {
					storageData.set(key, kv[key]);
					written.add(key);
				}
			},
			remove: async (k: string) => {
				storageData.delete(k);
				removed.add(k);
			},
		},
	};
	return { written, removed };
}

describe("extractDouyinStructuredContent", () => {
	function cleanup() {
		delete (browser as any).storage;
		vi.mocked(browser.runtime.sendMessage).mockReset();
	}

	test("uses caption track from SSR and parses vtt", async () => {
		const sendMessage = vi.mocked(browser.runtime.sendMessage);
		sendMessage.mockImplementation(async (message: any) => {
			if (message.action === "fetchDouyinCaption") {
				return {
					success: true,
					text: "WEBVTT\n\n00:00:00.000 --> 00:00:02.000\n第一句\n\n00:00:02.500 --> 00:00:04.000\n第二句\n",
				};
			}
			throw new Error(`unexpected ${message.action}`);
		});
		const { written } = setupStorage(new Map());
		const doc = makeDoc(
			`https://www.douyin.com/video/${AWEME.aweme_id}`,
			{ app: { videoInfoRes: { item_list: [AWEME] } } },
		);
		const content = await extractDouyinStructuredContent(doc);
		cleanup();
		expect(content?.transcript).toHaveLength(2);
		expect(content?.transcriptText).toContain("第一句");
		expect(content?.subtitleNotice).toBe("");
		expect(content?.author).toBe("测试作者");
		expect(content?.title).toBe("标题行");
		expect(content?.awemeId).toBe(AWEME.aweme_id);
		// 有字幕：不写"需转写"标记
		expect(
			[...written].some((k) => k.startsWith("dyNeedsTranscribe:")),
		).toBe(false);
	});

	test("falls back to cached AI transcript when no caption track", async () => {
		const aweme = JSON.parse(JSON.stringify(AWEME));
		aweme.video.cla_info = {};
		const storage = new Map([
			[
				`dyTranscript:${AWEME.aweme_id}`,
				{
					schemaVersion: 2,
					model: "Qwen/Qwen3-ASR-1.7B",
					segments: [
						{ startSec: 0, durationSec: 30, text: "转写第一段。" },
						{ startSec: 30, durationSec: 30, text: "转写第二段。" },
					],
					createdAt: 1,
				},
			],
		]);
		setupStorage(storage);
		const doc = makeDoc(
			`https://www.douyin.com/video/${AWEME.aweme_id}`,
			{ app: { videoInfoRes: { item_list: [aweme] } } },
		);
		const content = await extractDouyinStructuredContent(doc);
		cleanup();
		expect(content?.transcriptText).toContain("转写第一段");
		expect(content?.subtitleNotice).toContain("AI 语音转写");
		// 第二段时间锚为真实 30s
		const second = content?.transcript.find((c) =>
			c.content.includes("第二段"),
		);
		expect(second?.from).toBeGreaterThanOrEqual(30);
	});

	test("marks transcribe need when no captions and no cache", async () => {
		const aweme = JSON.parse(JSON.stringify(AWEME));
		aweme.video.cla_info = {};
		const { written } = setupStorage(new Map());
		const doc = makeDoc(
			`https://www.douyin.com/video/${AWEME.aweme_id}`,
			{ app: { videoInfoRes: { item_list: [aweme] } } },
		);
		const content = await extractDouyinStructuredContent(doc);
		cleanup();
		expect(content?.transcript).toHaveLength(0);
		expect(content?.subtitleNotice).toContain("AI 转写");
		expect(
			[...written].some(
				(k) => k === `dyNeedsTranscribe:${AWEME.aweme_id}`,
			),
		).toBe(true);
	});

	test("no data from any source → meta fallback, never null", async () => {
		const sendMessage = vi.mocked(browser.runtime.sendMessage);
		sendMessage.mockImplementation(async (message: any) => ({
			success: false,
			error: "no bridge",
		}));
		setupStorage(new Map());
		const doc = makeDoc("https://www.douyin.com/video/7301");
		const content = await extractDouyinStructuredContent(doc);
		cleanup();
		expect(content).not.toBeNull();
		expect(content?.subtitleNotice).toContain("未获取到视频数据");
		expect(content?.structuredHtml).not.toContain("推荐");
	});

	test("non-douyin pages return null", async () => {
		const doc = makeDoc("https://www.bilibili.com/video/BV1x");
		expect(await extractDouyinStructuredContent(doc)).toBeNull();
	});
});

describe("feed 页与陈列页", () => {
	function cleanup() {
		delete (browser as any).storage;
		vi.mocked(browser.runtime.sendMessage).mockReset();
	}

	test("isDouyinFeedUrl 仅识别沉浸式单列 feed", () => {
		expect(isDouyinFeedUrl("https://www.douyin.com/?recommend=1")).toBe(
			true,
		);
		expect(isDouyinFeedUrl("https://www.douyin.com/follow")).toBe(true);
		// 未登录推荐流的重定向目标，同为沉浸式 feed
		expect(isDouyinFeedUrl("https://www.douyin.com/jingxuan")).toBe(true);
		expect(
			isDouyinFeedUrl("https://www.douyin.com/user/self?showTab=favorite_collection"),
		).toBe(false);
		expect(isDouyinFeedUrl("https://www.douyin.com/search/健身")).toBe(
			false,
		);
	});

	test("findCurrentFeedAwemeId picks the anchor nearest viewport center", () => {
		const { document: doc } = parseHTML(
			`<html><body>
				<a href="/search/前一个视频?aweme_id=111&gid=111">前</a>
				<a href="/video/222?count=10">当前</a>
				<a href="https://www.douyin.com/search/后?aweme_id=333">后</a>
			</body></html>`,
		);
		const anchors = Array.from(doc.querySelectorAll("a"));
		const rects = [
			{ left: 0, top: 0, width: 10, height: 10 }, // 远离中心
			{ left: 600, top: 340, width: 10, height: 10 }, // 视口中心
			{ left: 0, top: 1400, width: 10, height: 10 }, // 视口外
		];
		anchors.forEach((el, i) => {
			(el as any).getBoundingClientRect = () => rects[i];
		});
		expect(findCurrentFeedAwemeId(doc as unknown as Document)).toBe("222");
	});

	test("feed 页提取当前正在观看的视频（桥数据）", async () => {
		const sendMessage = vi.mocked(browser.runtime.sendMessage);
		sendMessage.mockImplementation(async (message: any) => {
			if (
				message.action === "fetchDouyinBridgeData" &&
				message.awemeId === AWEME.aweme_id
			) {
				return { success: true, aweme: AWEME };
			}
			throw new Error(`unexpected ${message.action}`);
		});
		setupStorage(new Map());
		const { document: doc } = parseHTML(
			`<html><head><title>抖音</title></head><body>
				<a href="/search/x?aweme_id=111">前</a>
				<a href="/video/${AWEME.aweme_id}?count=10">当前</a>
			</body></html>`,
		);
		Object.defineProperty(doc, "URL", {
			value: "https://www.douyin.com/?recommend=1",
			configurable: true,
		});
		const anchors = Array.from(doc.querySelectorAll("a"));
		const rects = [
			{ left: 0, top: 0, width: 10, height: 10 },
			{ left: 600, top: 340, width: 10, height: 10 },
		];
		anchors.forEach((el, i) => {
			(el as any).getBoundingClientRect = () => rects[i];
		});
		const content = await extractDouyinStructuredContent(
			doc as unknown as Document,
		);
		cleanup();
		expect(content?.awemeId).toBe(AWEME.aweme_id);
		expect(content?.title).toBe("标题行");
		// 有字幕轨场景会继续走 fetchDouyinCaption——本用例 mock 未提供，
		// 落到"字幕轨拉取失败"提示
		expect(content?.subtitleNotice).toContain("未获取到字幕");
	});

	test("feed 页无法定位当前视频时给出指引兜底", async () => {
		setupStorage(new Map());
		const doc = makeDoc("https://www.douyin.com/?recommend=1");
		const content = await extractDouyinStructuredContent(doc);
		cleanup();
		expect(content?.subtitleNotice).toContain("详情页");
	});

	test("陈列页（用户主页/收藏）给出指引兜底而非整页内容", async () => {
		setupStorage(new Map());
		const doc = makeDoc(
			"https://www.douyin.com/user/self?showTab=favorite_collection",
		);
		const content = await extractDouyinStructuredContent(doc);
		cleanup();
		expect(content).not.toBeNull();
		expect(content?.subtitleNotice).toContain("陈列页");
		expect(content?.structuredHtml).not.toContain("批量管理");
	});

	test("UP 主主页页内模态播放（modal_id）提取当前视频", async () => {
		const sendMessage = vi.mocked(browser.runtime.sendMessage);
		sendMessage.mockImplementation(async (message: any) => {
			if (
				message.action === "fetchDouyinBridgeData" &&
				message.awemeId === AWEME.aweme_id
			) {
				return { success: true, aweme: AWEME };
			}
			throw new Error(`unexpected ${message.action}`);
		});
		setupStorage(new Map());
		const { document: doc } = parseHTML(
			`<html><head><title>主页</title></head><body>
				<video width="600" height="400"></video>
			</body></html>`,
		);
		// linkedom 的 video 无布局信息：直接 mock 一个大矩形
		(doc.querySelector("video") as any).getBoundingClientRect = () => ({
			left: 300,
			top: 200,
			width: 600,
			height: 400,
		});
		Object.defineProperty(doc, "URL", {
			value: `https://www.douyin.com/user/MS4wLjABtest?modal_id=${AWEME.aweme_id}`,
			configurable: true,
		});
		const content = await extractDouyinStructuredContent(
			doc as unknown as Document,
		);
		cleanup();
		expect(content?.awemeId).toBe(AWEME.aweme_id);
		expect(content?.title).toBe("标题行");
	});

	test("UP 主主页无播放（纯网格）仍走陈列页兜底", async () => {
		setupStorage(new Map());
		const doc = makeDoc(
			"https://www.douyin.com/user/MS4wLjABtest?showTab=post",
		);
		const content = await extractDouyinStructuredContent(doc);
		cleanup();
		expect(content?.subtitleNotice).toContain("陈列页");
	});
});

describe("collectDouyinAwemeAudio（SSR/桥合并）", () => {
	function cleanup() {
		vi.mocked(browser.runtime.sendMessage).mockReset();
	}

	test("merges SSR and bridge data, preferring the more complete copy", async () => {
		// SSR 缺 play_addr/music（直入详情页的常见形态）
		const ssrAweme = JSON.parse(JSON.stringify(AWEME));
		ssrAweme.video.play_addr = {};
		ssrAweme.music = {};
		const sendMessage = vi.mocked(browser.runtime.sendMessage);
		sendMessage.mockImplementation(async (message: any) => {
			if (message.action === "fetchDouyinBridgeData") {
				return { success: true, aweme: AWEME };
			}
			throw new Error(`unexpected ${message.action}`);
		});
		const doc = makeDoc(
			`https://www.douyin.com/video/${AWEME.aweme_id}`,
			{ app: { videoInfoRes: { item_list: [ssrAweme] } } },
		);
		const audio = await collectDouyinAwemeAudio(
			doc,
			AWEME.aweme_id,
		);
		cleanup();
		expect(audio?.audioUrl).toBe(AWEME.music.play_url.url_list[0]);
		expect(audio?.durationSec).toBe(90);
	});
});
