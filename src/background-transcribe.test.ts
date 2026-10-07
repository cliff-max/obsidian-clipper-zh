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
