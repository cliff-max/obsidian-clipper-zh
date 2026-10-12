import { describe, expect, test, vi } from "vitest";
import {
	assembleTranscript,
	buildPromptContext,
	isOversizeMessageError,
	sanitizeAsrText,
	startTranscribeTask,
	TranscribeHostLostError,
	type TranscribeTaskState,
} from "./background-transcribe";

vi.mock("./utils/browser-polyfill", () => ({
	default: {
		runtime: {
			sendMessage: vi.fn(),
		},
	},
}));

vi.mock("./background-bilibili-fetch", () => ({
	fetchBilibiliJsonDirect: vi.fn(),
	fetchBilibiliJsonWithCookiesDirect: vi.fn(),
	fetchBilibiliRangeDirect: vi.fn(),
	isAllowedBilibiliFetchUrl: () => true,
}));

vi.mock("./background-douyin-fetch", () => ({
	fetchDouyinAwemeAudio: vi.fn(),
	fetchDouyinAudioDirect: vi.fn(),
}));

import browser from "./utils/browser-polyfill";
import { fetchBilibiliJsonDirect } from "./background-bilibili-fetch";
import { encodeWav } from "./utils/audio-wav-encoder";

/** 1s 真实布局 WAV：供拆分补救等需要合法 WAV 载荷的用例使用 */
const SAMPLE_WAV = encodeWav(new Float32Array(16000), 16000);

const SETTINGS = {
	enabled: true,
	apiKey: "sk-t",
	model: "Qwen/Qwen3-ASR-1.7B",
	baseUrl: "https://api.siliconflow.cn",
};

function makeState(partial: Partial<TranscribeTaskState>): TranscribeTaskState {
	return {
		platform: "bilibili",
		targetKey: "BV1x:2",
		bvid: "BV1x",
		cid: 2,
		aid: 1,
		page: 1,
		durationSec: 180,
		model: "m",
		status: "running",
		chunkPlan: [],
		blockResults: [],
		totalSlices: 0,
		completedSlices: 0,
		promptContext: "",
		audioUrl: "",
		createdAt: 0,
		...partial,
	};
}

describe("assembleTranscript", () => {
	test("accumulates real decoded durations and marks failed blocks", () => {
		const out = assembleTranscript(
			makeState({
				chunkPlan: [
					{ start: 0, end: 10, startSec: 0, durationSec: 300 },
					{ start: 10, end: 20, startSec: 300, durationSec: 300 },
					{ start: 20, end: 30, startSec: 600, durationSec: 300 },
				],
				// 块 0 实际解码 280s（与计划的 300s 有偏差）：后续块时间轴
				// 必须以真实解码时长累计，而不是沿用计划值
				blockResults: [
					{
						slices: [
							{ startSec: 0, durationSec: 150, text: "a" },
							{ startSec: 150, durationSec: 130, text: null },
						],
						decodedSec: 280,
					},
					null,
					{
						slices: [{ startSec: 0, durationSec: 30, text: "c" }],
						decodedSec: 30,
					},
				],
			}),
		);
		expect(out).toEqual([
			{ startSec: 0, durationSec: 150, text: "a" },
			{ startSec: 150, durationSec: 130, text: "[02:30 起转写失败]" },
			{ startSec: 280, durationSec: 300, text: "[04:40-09:40 转写失败]" },
			{ startSec: 580, durationSec: 30, text: "c" },
		]);
	});
});

describe("sanitizeAsrText", () => {
	test("strips music markers and collapses hallucination loops", () => {
		expect(sanitizeAsrText("🎵 你好 🎼")).toBe("你好");
		expect(
			sanitizeAsrText("这个动作非常关键这个动作非常关键这个动作非常关键这个动作非常关键"),
		).toBe("这个动作非常关键");
		// 短叠词不折叠
		expect(sanitizeAsrText("对对对，很好")).toBe("对对对，很好");
	});
});

describe("buildPromptContext", () => {
	test("dedupes, flattens and caps", () => {
		const out = buildPromptContext(
			["标题", "标题", "UP主", "  ".repeat(10) + "简介"],
			10,
		);
		expect(out).toBe("标题；UP主；简介".slice(0, 10));
	});
});

describe("isOversizeMessageError", () => {
	test("recognizes message-size rejections, not host-lost", () => {
		expect(
			isOversizeMessageError(
				new TypeError("Message exceeded maximum allowed size of 64MiB."),
			),
		).toBe(true);
		expect(
			isOversizeMessageError(
				new Error(
					"Could not establish connection. Receiving end does not exist.",
				),
			),
		).toBe(false);
	});
});

function makeDeps(overrides: Partial<Record<string, any>> = {}) {
	const store = new Map<string, any>();
	const calls = {
		playurl: 0,
		ranges: [] as Array<[number, number]>,
		transcribe: [] as string[],
		prompts: [] as Array<string | undefined>,
		decodeFail: false,
		slicesPerBlock: 2,
	};
	const plan = [0, 1, 2].map((i) => ({
		start: 100 + i * 8000,
		end: 100 + (i + 1) * 8000,
		startSec: i * 60,
		durationSec: 60,
	}));
	return {
		calls,
		store,
		deps: {
			fetchStream: async () => {
				calls.playurl += 1;
				return {
					url: "https://upos.test/a.m4s",
					urls: ["https://upos.test/a.m4s"],
					sizeBytes: 24100,
					durationSec: 180,
					bitrateBps: 64000,
				};
			},
			downloadRange: async (_u: string, s: number, e: number) => {
				calls.ranges.push([s, e]);
				return new ArrayBuffer(Math.max(1, e - s));
			},
			fetchPlan: async () => plan,
			fetchPromptContext: async () => "标题；UP主",
			decodeSlices: async () => {
				if (calls.decodeFail) throw new Error("decode failed");
				return Array.from({ length: calls.slicesPerBlock }, (_, i) => ({
					startSec: i * 30,
					durationSec: 30,
					wav: SAMPLE_WAV.slice(0),
				}));
			},
			transcribe: async (
				_a: any,
				_m: string,
				f: string,
				s: any,
				opts?: { prompt?: string },
			) => {
				calls.transcribe.push(`${s.model}:${f}`);
				calls.prompts.push(opts?.prompt);
				return `文本${calls.transcribe.length}`;
			},
			storageGet: async (k: string) => store.get(k) ?? null,
			storageSet: async (k: string, v: any) => {
				store.set(k, v);
			},
			notify: vi.fn(),
			...overrides,
		},
	};
}

function bilibiliInput(overrides: Record<string, any> = {}) {
	return {
		platform: "bilibili" as const,
		bvid: "BV1x",
		aid: 1,
		cid: 2,
		durationSec: 180,
		tabId: 7,
		settings: SETTINGS as any,
		...overrides,
	};
}

describe("startTranscribeTask (bilibili)", () => {
	test("decodes blocks into slices, writes v2 cache with real timestamps", async () => {
		const { deps, calls, store } = makeDeps();
		await startTranscribeTask(bilibiliInput(), deps);
		expect(calls.playurl).toBe(1);
		// init segment 仅下载一次 + 每块数据一次
		expect(calls.ranges.length).toBe(4);
		// 3 块 × 2 细块，全部 wav 上传
		expect(calls.transcribe).toHaveLength(6);
		expect(
			calls.transcribe.every((entry) => entry.endsWith(".wav")),
		).toBe(true);
		// 热词上下文透传到每次转写
		expect(new Set(calls.prompts)).toEqual(new Set(["标题；UP主"]));

		const task = store.get("transcribeTask:BV1x:2");
		expect(task.status).toBe("done");
		expect(task.completedSlices).toBe(6);

		const final = store.get("biliTranscript:BV1x:2");
		expect(final.schemaVersion).toBe(2);
		expect(final.segments).toHaveLength(6);
		// 时间轴按真实解码时长累计：0/30/60/90/120/150
		expect(final.segments.map((s: any) => Math.round(s.startSec))).toEqual([
			0, 30, 60, 90, 120, 150,
		]);
	});

	test("falls back to SenseVoiceSmall whole-block upload when decode fails", async () => {
		const { deps, calls, store } = makeDeps();
		calls.decodeFail = true;
		await startTranscribeTask(bilibiliInput(), deps);
		expect(calls.transcribe).toHaveLength(3);
		expect(
			calls.transcribe.every(
				(entry) =>
					entry.startsWith("FunAudioLLM/SenseVoiceSmall:") &&
					entry.endsWith(".m4a"),
			),
		).toBe(true);
		const final = store.get("biliTranscript:BV1x:2");
		expect(final.segments).toHaveLength(3);
	});

	test("resume carries over completed slice texts on re-decoded blocks", async () => {
		const { deps, calls, store } = makeDeps();
		store.set("transcribeTask:BV1x:2", {
			...makeState({ status: "running" }),
			chunkPlan: [0, 1, 2].map((i) => ({
				start: 100 + i * 8000,
				end: 100 + (i + 1) * 8000,
				startSec: i * 60,
				durationSec: 60,
			})),
			blockResults: [
				{
					slices: [
						{ startSec: 0, durationSec: 30, text: "a" },
						{ startSec: 30, durationSec: 30, text: "b" },
					],
					decodedSec: 60,
				},
				{
					slices: [
						{ startSec: 0, durationSec: 30, text: "c" },
						{ startSec: 30, durationSec: 30, text: null },
					],
					decodedSec: 60,
				},
				null,
			],
			audioUrl: "https://upos.test/a.m4s",
		});
		await startTranscribeTask(bilibiliInput(), deps);
		// 块 0 完整跳过；块 1 只补第 2 细块；块 2 全新 → 3 次转写
		expect(calls.transcribe).toHaveLength(3);
		// init 一次 + 块 1 + 块 2
		expect(calls.ranges.length).toBe(3);
		const final = store.get("biliTranscript:BV1x:2");
		const texts = final.segments.map((s: any) => s.text);
		expect(texts).toContain("a");
		expect(texts).toContain("b");
		expect(texts).toContain("c");
	});

	test("host lost pauses task with notice instead of silent fallback", async () => {
		const { deps, store } = makeDeps();
		deps.decodeSlices = async () => {
			throw new TranscribeHostLostError("RECEIVER_UNAVAILABLE");
		};
		await startTranscribeTask(bilibiliInput(), deps);
		const task = store.get("transcribeTask:BV1x:2");
		expect(task.status).toBe("failed");
		expect(store.get("biliTranscript:BV1x:2")).toBeUndefined();
		expect(deps.notify).toHaveBeenCalledWith(
			expect.stringContaining("视频页"),
		);
	});

	test("401 during transcription fails whole task fast with readable notice", async () => {
		const { deps, store } = makeDeps();
		deps.transcribe = async () => {
			throw new Error("API Key 无效或余额不足");
		};
		await startTranscribeTask(bilibiliInput(), deps);
		const task = store.get("transcribeTask:BV1x:2");
		expect(task.status).toBe("failed");
		expect(store.get("biliTranscript:BV1x:2")).toBeUndefined();
		expect(deps.notify).toHaveBeenCalledWith(
			expect.stringContaining("API Key"),
		);
	});

	test("all blocks failed → status failed, no final cache", async () => {
		const { deps, store } = makeDeps();
		deps.downloadRange = async () => {
			throw new Error("audio url expired 403");
		};
		await startTranscribeTask(bilibiliInput(), deps);
		const task = store.get("transcribeTask:BV1x:2");
		expect(task.status).toBe("failed");
		expect(store.get("biliTranscript:BV1x:2")).toBeUndefined();
		expect(deps.notify).toHaveBeenCalledWith(
			expect.stringContaining("失败"),
		);
	});

	test("existing final cache short-circuits with notice and zero playurl", async () => {
		const { deps, calls } = makeDeps();
		// 预置缓存由 startTranscribeTask 自己读取
		const store = new Map<string, any>([
			[
				"biliTranscript:BV1x:2",
				{
					schemaVersion: 2,
					model: "m",
					segments: [{ startSec: 0, durationSec: 30, text: "done" }],
					createdAt: 1,
				},
			],
		]);
		deps.storageGet = async (k: string) => store.get(k) ?? null;
		await startTranscribeTask(bilibiliInput(), deps);
		expect(calls.playurl).toBe(0);
		expect(calls.ranges.length).toBe(0);
		expect(deps.notify).toHaveBeenCalledWith(
			expect.stringContaining("已有"),
		);
	});

	test("cache with failure placeholders does NOT short-circuit (re-transcribes)", async () => {
		const { deps, calls, store } = makeDeps();
		// 半成品缓存：含失败占位段——允许重新转写补齐，而非挡在"已有"之后
		store.set("biliTranscript:BV1x:2", {
			schemaVersion: 2,
			model: "m",
			segments: [
				{ startSec: 0, durationSec: 30, text: "旧文本" },
				{ startSec: 30, durationSec: 30, text: "[00:30 起转写失败]" },
			],
			createdAt: 1,
		});
		await startTranscribeTask(bilibiliInput(), deps);
		expect(calls.playurl).toBe(1);
		const final = store.get("biliTranscript:BV1x:2");
		expect(final.segments).toHaveLength(6);
		expect(
			final.segments.every((s: any) => !s.text.includes("转写失败")),
		).toBe(true);
	});

	test("done state with failures can be resumed to fill gaps", async () => {
		const { deps, calls, store } = makeDeps();
		const plan = [0, 1].map((i) => ({
			start: 100 + i * 8000,
			end: 100 + (i + 1) * 8000,
			startSec: i * 60,
			durationSec: 60,
		}));
		deps.fetchPlan = async () => plan;
		store.set("transcribeTask:BV1x:2", {
			...makeState({ status: "done" }),
			chunkPlan: plan,
			// 块 0 全部完成；块 1 解码过但全部细块失败
			blockResults: [
				{
					slices: [
						{ startSec: 0, durationSec: 30, text: "a" },
						{ startSec: 30, durationSec: 30, text: "b" },
					],
					decodedSec: 60,
				},
				{
					slices: [
						{ startSec: 0, durationSec: 30, text: null },
						{ startSec: 30, durationSec: 30, text: null },
					],
					decodedSec: 60,
				},
			],
			audioUrl: "https://upos.test/a.m4s",
		});
		await startTranscribeTask(bilibiliInput(), deps);
		// 只重做块 1：init 一次 + 块 1 数据
		expect(calls.ranges.length).toBe(2);
		expect(calls.transcribe).toHaveLength(2);
		const final = store.get("biliTranscript:BV1x:2");
		const texts = final.segments.map((s: any) => s.text);
		expect(texts).toContain("a");
		expect(texts).toContain("b");
		expect(texts.every((t: string) => !t.includes("转写失败"))).toBe(true);
	});

	test("duplicate invocation while running is rejected without second run", async () => {
		const { deps, calls } = makeDeps();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const orig = deps.transcribe;
		deps.transcribe = async (...args: any[]) => {
			await gate; // 挂住首个任务直到放行
			return (orig as any)(...args);
		};
		const first = startTranscribeTask(bilibiliInput(), deps);
		// 首个任务在飞时再次触发（模拟 alarm 恢复与浮层重试并发）
		await startTranscribeTask(bilibiliInput(), deps);
		expect(calls.transcribe).toHaveLength(0); // 第二次被守卫挡下且未跑完
		release();
		await first;
		expect(calls.transcribe).toHaveLength(6);
	});

	test("slice failure reason lands in placeholder text", async () => {
		const out = assembleTranscript(
			makeState({
				chunkPlan: [
					{ start: 0, end: 10, startSec: 0, durationSec: 60 },
				],
				blockResults: [
					{
						slices: [
							{
								startSec: 30,
								durationSec: 30,
								text: null,
								error: "HTTP 500",
							},
						],
						decodedSec: 60,
					},
				],
			}),
		);
		expect(out[0].text).toBe("[00:30 起转写失败（HTTP 500）]");
	});

	test("resolves cid for multi-part video via page param", async () => {
		const { deps, store } = makeDeps();
		const viewDirect = vi.mocked(fetchBilibiliJsonDirect);
		viewDirect.mockReset();
		viewDirect.mockImplementation(async (url: string) => {
			if (url.includes("/x/web-interface/view")) {
				return {
					code: 0,
					data: {
						aid: 9,
						cid: 111,
						pages: [
							{ page: 1, cid: 111 },
							{ page: 2, cid: 222 },
						],
					},
				};
			}
			throw new Error(`unexpected url ${url}`);
		});
		await startTranscribeTask(
			bilibiliInput({ bvid: "BV1mp", cid: 0, page: 2 }),
			deps,
		);
		const task = store.get("transcribeTask:BV1mp:222");
		expect(task).toBeTruthy();
		expect(task.cid).toBe(222);
	});

	test("block download failure refreshes signed url and retries once", async () => {
		const { deps, calls, store } = makeDeps();
		const failedOnce = new Set<number>();
		const origRange = deps.downloadRange;
		deps.downloadRange = async (
			url: string,
			start: number,
			end: number,
		) => {
			// 块 1（字节 8100 起）首次 403（签名过期），刷新 URL 后重试成功
			if (start === 8100 && !failedOnce.has(start)) {
				failedOnce.add(start);
				throw new Error("403 url expired");
			}
			calls.ranges.push([start, end]);
			return origRange(url, start, end);
		};
		await startTranscribeTask(bilibiliInput(), deps);
		// 初始取流 + 失败刷新 = 2 次 playurl
		expect(calls.playurl).toBe(2);
		const final = store.get("biliTranscript:BV1x:2");
		expect(final.segments).toHaveLength(6);
		expect(
			final.segments.every((s: any) => !s.text.includes("转写失败")),
		).toBe(true);
	});

	test("failed slices get one final retry round", async () => {
		const { deps, store } = makeDeps();
		const failedFiles = new Set<string>();
		const orig = deps.transcribe;
		deps.transcribe = async (
			audio: any,
			mime: string,
			filename: string,
			settings: any,
			opts?: any,
		) => {
			// block-1-1.wav 首转 429 失败，终轮重试（同名）成功
			if (filename === "block-1-1.wav" && !failedFiles.has(filename)) {
				failedFiles.add(filename);
				throw new Error("转写连续失败（HTTP 429）");
			}
			return (orig as any)(audio, mime, filename, settings, opts);
		};
		await startTranscribeTask(bilibiliInput(), deps);
		const final = store.get("biliTranscript:BV1x:2");
		expect(final.segments).toHaveLength(6);
		expect(
			final.segments.every((s: any) => !s.text.includes("转写失败")),
		).toBe(true);
	});

	test("deterministic 500 slice is rescued by wav split fallback", async () => {
		const { deps, store } = makeDeps();
		const orig = deps.transcribe;
		deps.transcribe = async (
			audio: any,
			mime: string,
			filename: string,
			settings: any,
			opts?: any,
		) => {
			// block-1-1.wav 整段始终 500（主模型+SenseVoice 同段同错），拆半后可过
			if (filename === "block-1-1.wav") {
				throw new Error("转写失败（HTTP 500）");
			}
			if (filename.endsWith("-h1.wav")) return "前半";
			if (filename.endsWith("-h2.wav")) return "后半";
			return (orig as any)(audio, mime, filename, settings, opts);
		};
		vi.useFakeTimers();
		try {
			const pending = startTranscribeTask(bilibiliInput(), deps);
			// 推进补救轮的 45s 冷却等待
			await vi.advanceTimersByTimeAsync(46_000);
			await pending;
		} finally {
			vi.useRealTimers();
		}
		const final = store.get("biliTranscript:BV1x:2");
		expect(final.segments).toHaveLength(6);
		const rescued = final.segments.find(
			(s: any) => s.text.includes("前半") || s.text.includes("后半"),
		);
		expect(rescued?.text).toBe("前半后半");
		expect(
			final.segments.every((s: any) => !s.text.includes("转写失败")),
		).toBe(true);
	});

	test("sustained network failures pause the task for later resume", async () => {
		const { deps, store } = makeDeps();
		const plan = Array.from({ length: 5 }, (_, i) => ({
			start: 100 + i * 8000,
			end: 100 + (i + 1) * 8000,
			startSec: i * 60,
			durationSec: 60,
		}));
		deps.fetchPlan = async () => plan;
		deps.transcribe = async () => {
			throw new Error(
				"转写请求网络失败：TypeError: Failed to fetch",
			);
		};
		await startTranscribeTask(bilibiliInput(), deps);
		const task = store.get("transcribeTask:BV1x:2");
		expect(task.status).toBe("failed");
		expect(task.error).toBe("网络中断");
		expect(deps.notify).toHaveBeenCalledWith(
			expect.stringContaining("网络中断"),
		);
		// 网络恢复后点击转写：failed 状态带未完成片段 → 续传补齐
		const { deps: deps2, store: store2 } = makeDeps();
		deps2.fetchPlan = async () => plan;
		store2.set("transcribeTask:BV1x:2", task);
		await startTranscribeTask(bilibiliInput(), deps2);
		const final = store2.get("biliTranscript:BV1x:2");
		expect(final.segments).toHaveLength(10);
		expect(
			final.segments.every((s: any) => !s.text.includes("转写失败")),
		).toBe(true);
	});

	test("transient decode failure is retried with a fresh download", async () => {
		const { deps, calls, store } = makeDeps();
		let decodeCalls = 0;
		const orig = deps.decodeSlices;
		deps.decodeSlices = async (...args: any[]) => {
			decodeCalls += 1;
			// 首次解码失败（瞬时损坏），重新下载后成功
			if (decodeCalls === 1) throw new Error("Unable to decode audio data");
			return (orig as any)(...args);
		};
		await startTranscribeTask(bilibiliInput(), deps);
		// 3 块计划中首个块解码 2 次，其余各 1 次
		expect(decodeCalls).toBe(4);
		// 没有走 m4a 整块降级：全部为 wav 细块
		expect(
			calls.transcribe.every((entry) => entry.endsWith(".wav")),
		).toBe(true);
		expect(calls.transcribe).toHaveLength(6);
		const final = store.get("biliTranscript:BV1x:2");
		expect(final.segments).toHaveLength(6);
	});

	test("403 on primary cdn rotates to backup url and sticks", async () => {
		const { deps, calls, store } = makeDeps();
		deps.fetchStream = async () => {
			calls.playurl += 1;
			return {
				url: "https://mcdn-pcdn.test/primary.m4s",
				urls: [
					"https://mcdn-pcdn.test/primary.m4s",
					"https://upos-backup.test/backup.m4s",
				],
				sizeBytes: 24100,
				durationSec: 180,
				bitrateBps: 64000,
			};
		};
		const usedUrls = new Set<string>();
		const orig = deps.downloadRange;
		deps.downloadRange = async (url: string, start: number, end: number) => {
			// 主地址（PCDN 节点）一律 403，备用地址正常
			if (url.includes("mcdn-pcdn")) {
				throw new Error("Bilibili range fetch failed with status 403");
			}
			usedUrls.add(url);
			return (orig as any)(url, start, end);
		};
		await startTranscribeTask(bilibiliInput(), deps);
		// 首个请求轮换到备用地址后粘住：主地址不再被反复探测
		const task = store.get("transcribeTask:BV1x:2");
		expect(task?.status).toBe("done");
		const final = store.get("biliTranscript:BV1x:2");
		expect(final.segments).toHaveLength(6);
		expect(usedUrls.has("https://upos-backup.test/backup.m4s")).toBe(true);
	});

	test("all cdn candidates rejected surfaces readable error", async () => {
		const { deps, store } = makeDeps();
		deps.fetchStream = async () => ({
			url: "https://a.test/1.m4s",
			urls: ["https://a.test/1.m4s", "https://b.test/2.m4s"],
			sizeBytes: 24100,
			durationSec: 180,
			bitrateBps: 64000,
		});
		// 走默认 fetchPlan：init 阶段头部下载即触发候选轮换（用户实测场景）
		(deps as any).fetchPlan = undefined;
		deps.downloadRange = async () => {
			throw new Error("Bilibili range fetch failed with status 403");
		};
		await startTranscribeTask(bilibiliInput(), deps);
		expect(deps.notify).toHaveBeenCalledWith(
			expect.stringContaining("全部地址被拒绝"),
		);
		const task = store.get("transcribeTask:BV1x:2");
		expect(task?.status).toBe("failed");
	});

	test("capped asr concurrency (≤5) while pipeline runs", async () => {
		const { deps, store } = makeDeps();
		const plan = Array.from({ length: 5 }, (_, i) => ({
			start: 100 + i * 8000,
			end: 100 + (i + 1) * 8000,
			startSec: i * 60,
			durationSec: 60,
		}));
		deps.fetchPlan = async () => plan;
		let inFlight = 0;
		let peak = 0;
		const orig = deps.transcribe;
		deps.transcribe = async (...args: any[]) => {
			inFlight += 1;
			peak = Math.max(peak, inFlight);
			await new Promise((r) => setTimeout(r, 20));
			inFlight -= 1;
			return (orig as any)(...args);
		};
		await startTranscribeTask(bilibiliInput(), deps);
		expect(peak).toBeLessThanOrEqual(5);
		expect(peak).toBeGreaterThan(1);
		expect(store.get("transcribeTask:BV1x:2").completedSlices).toBe(10);
	});

	test("fails immediately with readable error when apiKey missing", async () => {
		const { deps, calls } = makeDeps();
		await startTranscribeTask(
			bilibiliInput({ settings: { ...SETTINGS, apiKey: "" } }),
			deps,
		);
		expect(calls.playurl).toBe(0);
		expect(deps.notify).toHaveBeenCalledWith(
			expect.stringContaining("API Key"),
		);
	});
});

describe("startTranscribeTask (douyin)", () => {
	function douyinDeps(overrides: Partial<Record<string, any>> = {}) {
		const { calls, store, deps } = makeDeps() as any;
		deps.fetchDouyinAweme = async () => ({
			awemeId: "7001",
			audioUrl: "https://v3-web.douyinvod.com/x.mp3",
			audioMime: "audio/mpeg",
			audioExt: "mp3",
			sizeBytes: 1000,
			durationSec: 90,
			promptParts: ["抖音标题", "作者", "描述"],
		});
		deps.downloadDouyinAudio = async () => new ArrayBuffer(64);
		return { calls, store, deps: { ...deps, ...overrides } };
	}

	test("single-block download, prompt from aweme, cache under dy key", async () => {
		const { deps, calls, store } = douyinDeps();
		await startTranscribeTask(
			{
				platform: "douyin",
				awemeId: "7001",
				tabId: 7,
				settings: SETTINGS as any,
			},
			deps,
		);
		const task = store.get("transcribeTask:dy:7001");
		expect(task.status).toBe("done");
		expect(task.chunkPlan).toHaveLength(1);
		expect(calls.transcribe).toHaveLength(2);
		const final = store.get("dyTranscript:7001");
		expect(final.schemaVersion).toBe(2);
		expect(final.segments).toHaveLength(2);
		// 热词来自页面元数据
		expect(calls.prompts[0]).toContain("抖音标题");
	});

	test("rejects over-length videos with readable notice", async () => {
		const { deps, store } = douyinDeps();
		deps.fetchDouyinAweme = async () => ({
			awemeId: "7001",
			audioUrl: "https://v3-web.douyinvod.com/x.mp3",
			audioMime: "audio/mpeg",
			audioExt: "mp3",
			sizeBytes: 1,
			durationSec: 25 * 60,
			promptParts: [],
		});
		await startTranscribeTask(
			{
				platform: "douyin",
				awemeId: "7001",
				tabId: 7,
				settings: SETTINGS as any,
			},
			deps,
		);
		expect(deps.notify).toHaveBeenCalledWith(
			expect.stringContaining("超过抖音转写上限"),
		);
		// init 失败：占位状态落为 failed（可见原因），不残留 running
		const task = store.get("transcribeTask:dy:7001");
		expect(task?.status).toBe("failed");
		expect(task?.error).toContain("超过抖音转写上限");
	});

	test("placeholder running state is visible during slow init", async () => {
		const { deps, store } = makeDeps();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const orig = deps.fetchStream;
		deps.fetchStream = async (...args: any[]) => {
			await gate; // init 阶段挂住（模拟长视频取流/建计划耗时）
			return (orig as any)(...args);
		};
		const pending = startTranscribeTask(bilibiliInput(), deps);
		// 等 init 真正开始（占位已写入）
		await new Promise((resolve) => setTimeout(resolve, 20));
		const early = store.get("transcribeTask:BV1x:2");
		expect(early?.status).toBe("running");
		expect(early?.chunkPlan).toHaveLength(0); // starting 阶段标记
		release();
		await pending;
		const final = store.get("transcribeTask:BV1x:2");
		expect(final.status).toBe("done");
		expect(final.chunkPlan.length).toBeGreaterThan(0);
	});
});
