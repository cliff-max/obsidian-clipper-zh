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
	buildBilibiliStructuredHtml,
	buildBilibiliTranscriptMarkdown,
	extractBilibiliStructuredContent,
	isBilibiliVideoUrl,
	normalizeBilibiliSubtitleUrl,
	parseBilibiliUrl,
	resolveBilibiliPage,
} from "./bilibili-extractor";
import browser from "./browser-polyfill";

describe("bilibili extractor", () => {
	test("detects bilibili video pages", () => {
		expect(
			isBilibiliVideoUrl("https://www.bilibili.com/video/BV1xx411c7mD"),
		).toBe(true);
		expect(
			isBilibiliVideoUrl("https://www.bilibili.com/video/av123456"),
		).toBe(true);
		expect(isBilibiliVideoUrl("https://www.bilibili.com/read/cv123")).toBe(
			false,
		);
	});

	test("parses bvid and page from url", () => {
		expect(
			parseBilibiliUrl("https://www.bilibili.com/video/BV1xx411c7mD?p=2"),
		).toEqual({
			bvid: "BV1xx411c7mD",
			aid: null,
			page: 2,
			hasExplicitPageParam: true,
		});
	});

	test("parses aid style video urls", () => {
		expect(
			parseBilibiliUrl("https://www.bilibili.com/video/av170001"),
		).toEqual({
			bvid: null,
			aid: 170001,
			page: 1,
			hasExplicitPageParam: false,
		});
	});

	test("resolves current page cid from view api payload", () => {
		const pageData = resolveBilibiliPage(
			{
				cid: 111,
				duration: 120,
				pages: [
					{ page: 1, cid: 111, duration: 120, part: "P1" },
					{ page: 2, cid: 222, duration: 240, part: "P2" },
				],
			},
			2,
		);

		expect(pageData).toEqual({
			cid: 222,
			page: 2,
			part: "P2",
			duration: 240,
		});
	});

	test("normalizes protocol-relative subtitle urls", () => {
		expect(
			normalizeBilibiliSubtitleUrl("//i0.hdslb.com/subtitle.json"),
		).toBe("https://i0.hdslb.com/subtitle.json");
		expect(
			normalizeBilibiliSubtitleUrl("https://i0.hdslb.com/subtitle.json"),
		).toBe("https://i0.hdslb.com/subtitle.json");
	});

	test("groups transcript by chapters in markdown output", () => {
		const markdown = buildBilibiliTranscriptMarkdown(
			[
				{ from: 1, to: 3, content: "开场白" },
				{ from: 65, to: 70, content: "第二段" },
			],
			[
				{ title: "第一章", from: 0, to: 60 },
				{ title: "第二章", from: 60, to: 120 },
			],
		);

		expect(markdown).toContain("### 第一章");
		expect(markdown).toContain("`00:01` 开场白");
		expect(markdown).toContain("### 第二章");
		expect(markdown).toContain("`01:05` 第二段");
	});

	test("builds structured html without unrelated page fragments", () => {
		const html = buildBilibiliStructuredHtml({
			description: "这是简介",
			chapters: [{ title: "第一章", from: 0, to: 60 }],
			transcript: [{ from: 5, to: 10, content: "你好，世界" }],
		});

		expect(html).toContain("<h2>简介</h2>");
		expect(html).toContain("<h2>章节</h2>");
		expect(html).toContain("<h2>字幕</h2>");
		expect(html).toContain("你好，世界");
		expect(html).not.toContain("推荐视频");
		expect(html).not.toContain("评论");
	});

	test("builds clean html for videos without subtitles", () => {
		const html = buildBilibiliStructuredHtml({
			description: "仅保留简介和章节",
			chapters: [{ title: "第一章", from: 0, to: 60 }],
			transcript: [],
		});

		expect(html).toContain("<h2>简介</h2>");
		expect(html).toContain("<h2>章节</h2>");
		expect(html).not.toContain("<h2>字幕</h2>");
	});

	test("falls back to page-context player data when proxied player response has no subtitle tracks", async () => {
		const sendMessage = vi.mocked(browser.runtime.sendMessage);
		sendMessage.mockReset();
		sendMessage.mockImplementation(async (message: any) => {
			if (
				message.action === "fetchBilibiliJson" &&
				message.url.includes("/x/web-interface/view")
			) {
				return {
					success: true,
					data: {
						code: 0,
						data: {
							aid: 123,
							bvid: "BV1cGigBQE6n",
							title: "测试视频",
							desc: "测试简介",
							cid: 456,
							pages: [
								{ page: 1, cid: 456, duration: 30, part: "P1" },
							],
						},
					},
				};
			}
			if (
				message.action === "fetchBilibiliJson" &&
				message.url.includes("/x/web-interface/nav")
			) {
				return {
					success: true,
					data: {
						code: 0,
						data: {
							wbi_img: {
								img_url:
									"https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png",
								sub_url:
									"https://i0.hdslb.com/bfs/wbi/4932caff0ff74675b6ecd3d1519e7b76.png",
							},
						},
					},
				};
			}
			if (
				message.action === "fetchBilibiliJson" &&
				message.url.includes("/x/player/wbi/v2")
			) {
				return {
					success: true,
					data: {
						code: 0,
						data: {
							subtitle: { subtitles: [] },
							view_points: [],
						},
					},
				};
			}
			if (message.action === "fetchBilibiliJsonWithCookies") {
				// 模拟未登录/不支持场景：cookie 注入请求失败，走后续回退
				return { success: false, error: "No Bilibili cookies found" };
			}
			if (message.action === "fetchBilibiliJsonViaMainWorld") {
				return {
					success: true,
					data: {
						code: 0,
						data: {
							subtitle: {
								subtitles: [
									{
										lan: "ai-zh",
										lan_doc: "中文（自动生成）",
										subtitle_url:
											"//i0.hdslb.com/bfs/subtitle/test.json",
									},
								],
							},
							view_points: [],
						},
					},
				};
			}
			if (
				message.action === "fetchBilibiliJson" &&
				message.url.includes("/bfs/subtitle/test.json")
			) {
				return {
					success: true,
					data: {
						body: [{ from: 1, to: 3, content: "Safari 字幕" }],
					},
				};
			}
			throw new Error(
				`Unexpected message ${message.action}: ${message.url || ""}`,
			);
		});

		const { document: doc } = parseHTML(
			"<html><head><title>Bilibili</title></head><body></body></html>",
		);
		Object.defineProperty(doc, "URL", {
			value: "https://www.bilibili.com/video/BV1cGigBQE6n/",
			configurable: true,
		});

		const content = await extractBilibiliStructuredContent(
			doc as unknown as Document,
		);

		expect(content?.transcriptText).toBe("Safari 字幕");
		const wbiCall = sendMessage.mock.calls.find(
			([msg]: any[]) =>
				msg.action === "fetchBilibiliJson" &&
				msg.url.includes("/x/player/wbi/v2"),
		);
		const wbiCallUrl = (wbiCall?.[0] as any)?.url ?? "";
		expect(wbiCallUrl).toMatch(/[?&]w_rid=[0-9a-f]{32}/);
		expect(wbiCallUrl).toMatch(/[?&]wts=\d+/);
		expect(sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				action: "fetchBilibiliJsonViaMainWorld",
			}),
		);
	});

	test("surfaces a visible notice when no subtitle track is available", async () => {
		const sendMessage = vi.mocked(browser.runtime.sendMessage);
		sendMessage.mockReset();
		sendMessage.mockImplementation(async (message: any) => {
			if (
				message.action === "fetchBilibiliJson" &&
				message.url.includes("/x/web-interface/view")
			) {
				return {
					success: true,
					data: {
						code: 0,
						data: {
							aid: 123,
							bvid: "BV1noSubtitle1",
							title: "无字幕视频",
							desc: "简介",
							cid: 456,
							pages: [
								{ page: 1, cid: 456, duration: 30, part: "P1" },
							],
						},
					},
				};
			}
			if (
				message.action === "fetchBilibiliJson" &&
				message.url.includes("/x/web-interface/nav")
			) {
				return {
					success: true,
					data: {
						code: 0,
						data: {
							wbi_img: {
								img_url:
									"https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png",
								sub_url:
									"https://i0.hdslb.com/bfs/wbi/4932caff0ff74675b6ecd3d1519e7b76.png",
							},
						},
					},
				};
			}
			if (
				message.action === "fetchBilibiliJson" &&
				message.url.includes("/x/player/")
			) {
				return {
					success: true,
					data: {
						code: 0,
						data: {
							subtitle: { subtitles: [] },
							view_points: [{ content: "第一章", from: 0 }],
						},
					},
				};
			}
			if (message.action === "fetchBilibiliJsonWithCookies") {
				return { success: false, error: "No Bilibili cookies found" };
			}
			if (message.action === "fetchBilibiliJsonViaMainWorld") {
				return {
					success: true,
					data: {
						code: 0,
						data: {
							subtitle: { subtitles: [] },
							view_points: [],
						},
					},
				};
			}
			throw new Error(
				`Unexpected message ${message.action}: ${message.url || ""}`,
			);
		});

		const { document: doc } = parseHTML(
			"<html><head><title>Bilibili</title></head><body></body></html>",
		);
		Object.defineProperty(doc, "URL", {
			value: "https://www.bilibili.com/video/BV1noSubtitle1/",
			configurable: true,
		});

		const content = await extractBilibiliStructuredContent(
			doc as unknown as Document,
		);

		expect(content?.transcript).toHaveLength(0);
		expect(content?.subtitleNotice).toContain("登录 B 站");
		expect(content?.structuredHtml).toContain("bilibili-subtitle-notice");
	});

	test("uses cookie-injected player data when anonymous response has no subtitle tracks", async () => {
		const sendMessage = vi.mocked(browser.runtime.sendMessage);
		sendMessage.mockReset();
		sendMessage.mockImplementation(async (message: any) => {
			if (
				message.action === "fetchBilibiliJson" &&
				message.url.includes("/x/web-interface/view")
			) {
				return {
					success: true,
					data: {
						code: 0,
						data: {
							aid: 123,
							bvid: "BV1aiSubtitle1",
							title: "AI字幕视频",
							desc: "简介",
							cid: 456,
							pages: [
								{ page: 1, cid: 456, duration: 30, part: "P1" },
							],
						},
					},
				};
			}
			if (
				message.action === "fetchBilibiliJson" &&
				message.url.includes("/x/web-interface/nav")
			) {
				return {
					success: true,
					data: {
						code: 0,
						data: {
							wbi_img: {
								img_url:
									"https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png",
								sub_url:
									"https://i0.hdslb.com/bfs/wbi/4932caff0ff74675b6ecd3d1519e7b76.png",
							},
						},
					},
				};
			}
			if (
				message.action === "fetchBilibiliJson" &&
				message.url.includes("/x/player/")
			) {
				// 匿名请求：有章节、无字幕轨（与线上真实行为一致）
				return {
					success: true,
					data: {
						code: 0,
						data: {
							subtitle: { subtitles: [] },
							view_points: [{ content: "第一章", from: 0 }],
						},
					},
				};
			}
			if (message.action === "fetchBilibiliJsonWithCookies") {
				// cookie 注入请求带回 AI 字幕轨与登录身份
				return {
					success: true,
					data: {
						code: 0,
						data: {
							login_mid: 1148704645,
							subtitle: {
								subtitles: [
									{
										lan: "ai-zh",
										lan_doc: "中文（自动生成）",
										subtitle_url:
											"//aisubtitle.hdslb.com/bfs/ai_subtitle/test.json",
									},
								],
							},
							view_points: [{ content: "第一章", from: 0 }],
						},
					},
				};
			}
			if (
				message.action === "fetchBilibiliJson" &&
				message.url.includes("/ai_subtitle/test.json")
			) {
				return {
					success: true,
					data: {
						body: [
							{ from: 0, to: 2, content: "♪ 无心过问你的心里 ♪" },
							{ from: 3, to: 5, content: "登录态拿到的 AI 字幕" },
						],
					},
				};
			}
			throw new Error(
				`Unexpected message ${message.action}: ${message.url || ""}`,
			);
		});

		const { document: doc } = parseHTML(
			"<html><head><title>Bilibili</title></head><body></body></html>",
		);
		Object.defineProperty(doc, "URL", {
			value: "https://www.bilibili.com/video/BV1aiSubtitle1/",
			configurable: true,
		});

		const content = await extractBilibiliStructuredContent(
			doc as unknown as Document,
		);

		// BGM 歌词转写被过滤，只保留语音内容
		expect(content?.transcriptText).toBe("登录态拿到的 AI 字幕");
		expect(content?.subtitleNotice).toBe("");
		expect(content?.structuredHtml).not.toContain(
			"bilibili-subtitle-notice",
		);
	});

	test("reports no subtitle available when logged-in player response has no tracks", async () => {
		const sendMessage = vi.mocked(browser.runtime.sendMessage);
		sendMessage.mockReset();
		sendMessage.mockImplementation(async (message: any) => {
			if (
				message.action === "fetchBilibiliJson" &&
				message.url.includes("/x/web-interface/view")
			) {
				return {
					success: true,
					data: {
						code: 0,
						data: {
							aid: 123,
							bvid: "BV1loggedInNoSub",
							title: "登录仍无字幕视频",
							desc: "好人松松合集简介",
							cid: 456,
							pages: [
								{ page: 1, cid: 456, duration: 30, part: "P1" },
							],
						},
					},
				};
			}
			if (
				message.action === "fetchBilibiliJson" &&
				message.url.includes("/x/web-interface/nav")
			) {
				return {
					success: true,
					data: {
						code: 0,
						data: {
							wbi_img: {
								img_url:
									"https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png",
								sub_url:
									"https://i0.hdslb.com/bfs/wbi/4932caff0ff74675b6ecd3d1519e7b76.png",
							},
						},
					},
				};
			}
			if (
				message.action === "fetchBilibiliJson" &&
				message.url.includes("/x/player/")
			) {
				return {
					success: true,
					data: {
						code: 0,
						data: {
							subtitle: { subtitles: [] },
							view_points: [{ content: "第一章", from: 0 }],
						},
					},
				};
			}
			if (message.action === "fetchBilibiliJsonWithCookies") {
				// 登录态生效（login_mid 存在）但依然无字幕轨——B 站侧没有生成字幕
				return {
					success: true,
					data: {
						code: 0,
						data: {
							login_mid: 1148704645,
							subtitle: { subtitles: [] },
							view_points: [{ content: "第一章", from: 0 }],
						},
					},
				};
			}
			throw new Error(
				`Unexpected message ${message.action}: ${message.url || ""}`,
			);
		});

		const { document: doc } = parseHTML(
			"<html><head><title>Bilibili</title></head><body></body></html>",
		);
		Object.defineProperty(doc, "URL", {
			value: "https://www.bilibili.com/video/BV1loggedInNoSub/",
			configurable: true,
		});

		const content = await extractBilibiliStructuredContent(
			doc as unknown as Document,
		);

		expect(content?.transcript).toHaveLength(0);
		// 已登录仍无轨：明确告知视频没有字幕，不再误导用户去登录
		expect(content?.subtitleNotice).toContain("没有可用字幕");
		expect(content?.subtitleNotice).not.toContain("登录 B 站");
		expect(content?.chaptersMarkdown).toContain("第一章");
	});

	test("keeps chapters and description when subtitle file fetch fails", async () => {
		const sendMessage = vi.mocked(browser.runtime.sendMessage);
		sendMessage.mockReset();
		sendMessage.mockImplementation(async (message: any) => {
			if (
				message.action === "fetchBilibiliJson" &&
				message.url.includes("/x/web-interface/view")
			) {
				return {
					success: true,
					data: {
						code: 0,
						data: {
							aid: 123,
							bvid: "BV1subFileFail1",
							title: "字幕文件拉取失败视频",
							desc: "字幕 403 时的简介",
							cid: 456,
							pages: [
								{ page: 1, cid: 456, duration: 30, part: "P1" },
							],
						},
					},
				};
			}
			if (
				message.action === "fetchBilibiliJson" &&
				message.url.includes("/x/web-interface/nav")
			) {
				return {
					success: true,
					data: {
						code: 0,
						data: {
							wbi_img: {
								img_url:
									"https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png",
								sub_url:
									"https://i0.hdslb.com/bfs/wbi/4932caff0ff74675b6ecd3d1519e7b76.png",
							},
						},
					},
				};
			}
			if (
				message.action === "fetchBilibiliJson" &&
				message.url.includes("/x/player/")
			) {
				return {
					success: true,
					data: {
						code: 0,
						data: {
							subtitle: { subtitles: [] },
							view_points: [{ content: "第一章", from: 0 }],
						},
					},
				};
			}
			if (message.action === "fetchBilibiliJsonWithCookies") {
				return {
					success: true,
					data: {
						code: 0,
						data: {
							login_mid: 1148704645,
							subtitle: {
								subtitles: [
									{
										lan: "ai-zh",
										lan_doc: "中文（自动生成）",
										subtitle_url:
											"//aisubtitle.hdslb.com/bfs/ai_subtitle/expired.json",
									},
								],
							},
							view_points: [{ content: "第一章", from: 0 }],
						},
					},
				};
			}
			if (
				message.action === "fetchBilibiliJson" &&
				message.url.includes("/ai_subtitle/expired.json")
			) {
				// 字幕文件 auth_key 过期/403：整个请求失败
				return {
					success: false,
					error: "Bilibili fetch failed with status 403",
				};
			}
			throw new Error(
				`Unexpected message ${message.action}: ${message.url || ""}`,
			);
		});

		const { document: doc } = parseHTML(
			"<html><head><title>Bilibili</title></head><body></body></html>",
		);
		Object.defineProperty(doc, "URL", {
			value: "https://www.bilibili.com/video/BV1subFileFail1/",
			configurable: true,
		});

		const content = await extractBilibiliStructuredContent(
			doc as unknown as Document,
		);

		// 字幕文件失败不应炸掉整个提取：简介与章节仍在，字幕降级为提示
		expect(content).not.toBeNull();
		expect(content?.description).toBe("字幕 403 时的简介");
		expect(content?.chaptersMarkdown).toContain("第一章");
		expect(content?.transcript).toHaveLength(0);
		expect(content?.subtitleNotice).toContain("字幕内容拉取失败");
	});
});
