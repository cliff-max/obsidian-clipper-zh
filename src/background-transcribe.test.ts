import { describe, expect, test, vi } from "vitest";
import {
	assembleTranscript,
	startTranscribeTask,
} from "./background-transcribe";

const SETTINGS = {
	enabled: true,
	apiKey: "sk-t",
	model: "Qwen/Qwen3-ASR-1.7B",
	baseUrl: "https://api.siliconflow.cn",
};

describe("assembleTranscript", () => {
	test("joins chunks and marks failed ones", () => {
		const out = assembleTranscript({
			bvid: "BV1x",
			cid: 1,
			aid: 1,
			durationSec: 100,
			model: "m",
			status: "done",
			totalChunks: 3,
			completedChunks: 2,
			chunkResults: [
				{ startSec: 0, text: "第一段" },
				null,
				{ startSec: 600, text: "第三段" },
			],
			chunkPlan: [],
			audioUrl: "",
			createdAt: 0,
		});
		expect(out).toEqual([
			{ startSec: 0, text: "第一段" },
			{ startSec: 33, text: "[第 2 段转写失败]" },
			{ startSec: 600, text: "第三段" },
		]);
	});
});

function makeDeps(overrides: Partial<Record<string, any>> = {}) {
	const store = new Map<string, any>();
	const calls = {
		playurl: 0,
		ranges: [] as Array<[number, number]>,
		transcribe: [] as string[],
		decodeFail: false,
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
			decodeWav: async () => {
				if (calls.decodeFail) throw new Error("decode failed");
				return new ArrayBuffer(10);
			},
			transcribe: async (_a: any, _m: string, _f: string, s: any) => {
				calls.transcribe.push(s.model);
				return `块${calls.transcribe.length}`;
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

describe("startTranscribeTask", () => {
	test("runs all chunks, persists progress and final cache", async () => {
		const { deps, calls, store } = makeDeps();
		await startTranscribeTask(
			{
				bvid: "BV1x",
				aid: 1,
				cid: 2,
				durationSec: 180,
				tabId: 7,
				settings: SETTINGS as any,
			},
			deps,
		);
		expect(calls.playurl).toBe(1);
		// init segment 仅下载一次 + 每块数据一次
		expect(calls.ranges.length).toBe(4);
		expect(calls.transcribe).toEqual([
			"Qwen/Qwen3-ASR-1.7B",
			"Qwen/Qwen3-ASR-1.7B",
			"Qwen/Qwen3-ASR-1.7B",
		]);
		const task = store.get("transcribeTask:BV1x:2");
		expect(task.status).toBe("done");
		expect(task.completedChunks).toBe(3);
		const final = store.get("biliTranscript:BV1x:2");
		expect(final.chunks.map((c: any) => c.text)).toEqual([
			"块1",
			"块2",
			"块3",
		]);
	});

	test("resumes from persisted state without redoing finished chunks", async () => {
		const { deps, calls, store } = makeDeps();
		const plan = [0, 1, 2, 3, 4].map((i) => ({
			start: 100 + i * 8000,
			end: 100 + (i + 1) * 8000,
			startSec: i * 60,
			durationSec: 60,
		}));
		deps.fetchPlan = async () => plan;
		store.set("transcribeTask:BV1x:3", {
			bvid: "BV1x",
			cid: 3,
			aid: 1,
			durationSec: 300,
			model: SETTINGS.model,
			status: "running",
			totalChunks: 5,
			completedChunks: 2,
			chunkResults: [
				{ startSec: 0, text: "a" },
				{ startSec: 60, text: "b" },
				null,
				null,
				null,
			],
			chunkPlan: plan,
			audioUrl: "https://upos.test/a.m4s",
			createdAt: Date.now(),
		});
		await startTranscribeTask(
			{
				bvid: "BV1x",
				aid: 1,
				cid: 3,
				durationSec: 300,
				tabId: 7,
				settings: SETTINGS as any,
			},
			deps,
		);
		expect(calls.ranges.length).toBe(4); // init 一次 + 3 个缺失块数据
		const task = store.get("transcribeTask:BV1x:3");
		expect(task.completedChunks).toBe(5);
		expect(task.chunkResults[0].text).toBe("a");
	});

	test("falls back to SenseVoiceSmall when wav decode fails", async () => {
		const { deps, calls, store } = makeDeps();
		calls.decodeFail = true;
		await startTranscribeTask(
			{
				bvid: "BV1x",
				aid: 1,
				cid: 2,
				durationSec: 180,
				tabId: 7,
				settings: SETTINGS as any,
			},
			deps,
		);
		expect(calls.transcribe).toEqual([
			"FunAudioLLM/SenseVoiceSmall",
			"FunAudioLLM/SenseVoiceSmall",
			"FunAudioLLM/SenseVoiceSmall",
		]);
		expect(store.get("transcribeTask:BV1x:2").status).toBe("done");
	});

	test("fails immediately with readable error when apiKey missing", async () => {
		const { deps, calls } = makeDeps();
		await startTranscribeTask(
			{
				bvid: "BV1x",
				aid: 1,
				cid: 2,
				durationSec: 180,
				tabId: 7,
				settings: { ...SETTINGS, apiKey: "" } as any,
			},
			deps,
		);
		expect(calls.playurl).toBe(0);
		expect(deps.notify).toHaveBeenCalledWith(
			expect.stringContaining("API Key"),
		);
	});
});

describe("review fixes", () => {
	test("transcribe wav failure does NOT fall back to m4a (no double billing)", async () => {
		const { deps, calls, store } = makeDeps();
		deps.transcribe = async (_a: any, _m: string, f: string) => {
			calls.transcribe.push(f);
			if (f.endsWith(".wav")) throw new Error("转写连续失败（HTTP 429）");
			throw new Error("should not be called for m4a");
		};
		await startTranscribeTask(
			{ bvid: "BV1x", aid: 1, cid: 2, durationSec: 180, tabId: 7, settings: SETTINGS as any },
			deps,
		);
		// 仅 wav 调用 3 次，绝不发起 m4a 直传
		expect(calls.transcribe.filter((f) => f.endsWith(".wav"))).toHaveLength(3);
		expect(calls.transcribe.some((f) => f.endsWith(".m4a"))).toBe(false);
		const task = store.get("transcribeTask:BV1x:2");
		expect(task.chunkResults.every((c: any) => c === null)).toBe(true);
	});

	test("401 during transcription fails whole task fast with readable notice", async () => {
		const { deps, calls, store } = makeDeps();
		deps.transcribe = async (_a: any, _m: string, f: string) => {
			calls.transcribe.push(f);
			throw new Error("API Key 无效或余额不足");
		};
		await startTranscribeTask(
			{ bvid: "BV1x", aid: 1, cid: 2, durationSec: 180, tabId: 7, settings: SETTINGS as any },
			deps,
		);
		// 401 快速失败：仅第一块即停，任务 failed，无成品缓存
		expect(calls.transcribe).toHaveLength(1);
		const task = store.get("transcribeTask:BV1x:2");
		expect(task.status).toBe("failed");
		expect(store.get("biliTranscript:BV1x:2")).toBeUndefined();
		expect(deps.notify).toHaveBeenCalledWith(expect.stringContaining("API Key"));
	});

	test("host lost (page closed) pauses task with notice instead of silent fallback", async () => {
		const { deps, calls, store } = makeDeps();
		let wavCalls = 0;
		deps.decodeWav = async () => {
			wavCalls += 1;
			if (wavCalls >= 1) throw new Error("RECEIVER_UNAVAILABLE: could not establish connection");
		};
		deps.transcribe = async () => {
			throw new Error("should not transcribe when host lost");
		};
		await startTranscribeTask(
			{ bvid: "BV1x", aid: 1, cid: 2, durationSec: 180, tabId: 7, settings: SETTINGS as any },
			deps,
		);
		const task = store.get("transcribeTask:BV1x:2");
		expect(task.status).toBe("failed");
		expect(store.get("biliTranscript:BV1x:2")).toBeUndefined();
		expect(deps.notify).toHaveBeenCalledWith(expect.stringContaining("视频页"));
	});

	test("all chunks failed → status failed, no final cache, failure notice", async () => {
		const { deps, store } = makeDeps();
		deps.downloadRange = async () => {
			throw new Error("audio url expired 403");
		};
		await startTranscribeTask(
			{ bvid: "BV1x", aid: 1, cid: 2, durationSec: 180, tabId: 7, settings: SETTINGS as any },
			deps,
		);
		const task = store.get("transcribeTask:BV1x:2");
		expect(task.status).toBe("failed");
		expect(store.get("biliTranscript:BV1x:2")).toBeUndefined();
		expect(deps.notify).toHaveBeenCalledWith(expect.stringContaining("失败"));
	});

	test("resume refreshes expired audioUrl via fetchStream while keeping progress", async () => {
		const { deps, calls, store } = makeDeps();
		const plan = [0, 1, 2, 3, 4].map((i) => ({
			start: 100 + i * 8000, end: 100 + (i + 1) * 8000, startSec: i * 60, durationSec: 60,
		}));
		deps.fetchPlan = async () => plan;
		let streamCalls = 0;
		deps.fetchStream = async () => {
			streamCalls += 1;
			calls.playurl += 1;
			return {
				url: `https://upos.test/a-v${streamCalls}.m4s`,
				sizeBytes: 40100, durationSec: 300, bitrateBps: 64000,
			};
		};
		store.set("transcribeTask:BV1x:3", {
			bvid: "BV1x", cid: 3, aid: 1, durationSec: 300, model: SETTINGS.model,
			status: "running", totalChunks: 5, completedChunks: 2,
			chunkResults: [{ startSec: 0, text: "a" }, { startSec: 60, text: "b" }, null, null, null],
			chunkPlan: plan, audioUrl: "https://upos.test/expired.m4s", createdAt: Date.now(),
		});
		await startTranscribeTask(
			{ bvid: "BV1x", aid: 1, cid: 3, durationSec: 300, tabId: 7, settings: SETTINGS as any },
			deps,
		);
		// resume 也重新取流（刷新签名 URL），且已完成块不重做
		expect(streamCalls).toBeGreaterThanOrEqual(1);
		const task = store.get("transcribeTask:BV1x:3");
		expect(task.audioUrl).toContain("a-v");
		expect(task.completedChunks).toBe(5);
		const ranges = calls.ranges.map(([s]: any) => s);
		expect(ranges.some((s: number) => s === 0)).toBe(true);
	});

	test("existing final cache short-circuits with notice and zero playurl", async () => {
		const { deps, calls, store } = makeDeps();
		store.set("biliTranscript:BV1x:2", { model: "m", chunks: [], createdAt: 1 });
		await startTranscribeTask(
			{ bvid: "BV1x", aid: 1, cid: 2, durationSec: 180, tabId: 7, settings: SETTINGS as any },
			deps,
		);
		expect(calls.playurl).toBe(0);
		expect(calls.ranges.length).toBe(0);
		expect(deps.notify).toHaveBeenCalledWith(expect.stringContaining("已有"));
	});

	test("resolves cid for multi-part video via page param", async () => {
		const { deps, store } = makeDeps();
		const browserModule = await import("./utils/browser-polyfill");
		const sendMessage = vi.mocked(browserModule.default.runtime.sendMessage);
		sendMessage.mockReset();
		sendMessage.mockImplementation(async (message: any) => {
			if (message.action === "fetchBilibiliJson" && message.url.includes("/x/web-interface/view")) {
				return { success: true, data: { code: 0, data: {
					aid: 9, cid: 111,
					pages: [{ page: 1, cid: 111 }, { page: 2, cid: 222 }],
				} } };
			}
			throw new Error(`unexpected ${message.action}`);
		});
		await startTranscribeTask(
			{ bvid: "BV1mp", aid: 0, cid: 0, page: 2, durationSec: 0, tabId: 7, settings: SETTINGS as any },
			deps,
		);
		const task = store.get("transcribeTask:BV1mp:222");
		expect(task).toBeTruthy();
		expect(task.cid).toBe(222);
	});

	test("runs chunks with concurrency limit of 3", async () => {
		const { deps, store } = makeDeps();
		const plan = Array.from({ length: 6 }, (_, i) => ({
			start: 100 + i * 8000, end: 100 + (i + 1) * 8000, startSec: i * 60, durationSec: 60,
		}));
		deps.fetchPlan = async () => plan;
		let inFlight = 0;
		let peak = 0;
		const origTranscribe = deps.transcribe;
		deps.transcribe = async (...args: any[]) => {
			inFlight += 1;
			peak = Math.max(peak, inFlight);
			await new Promise((r) => setTimeout(r, 30));
			inFlight -= 1;
			return (origTranscribe as any)(...args);
		};
		await startTranscribeTask(
			{ bvid: "BV1x", aid: 1, cid: 2, durationSec: 360, tabId: 7, settings: SETTINGS as any },
			deps,
		);
		expect(peak).toBe(3);
		expect(store.get("transcribeTask:BV1x:2").completedChunks).toBe(6);
	});
});
