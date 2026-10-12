import { describe, expect, test, vi } from "vitest";
import { transcribeAudioBlob } from "./transcribe-client";

const SETTINGS = {
	enabled: true,
	apiKey: "sk-test",
	model: "Qwen/Qwen3-ASR-1.7B",
	baseUrl: "https://api.siliconflow.cn",
};

function jsonResponse(body: any, status = 200, headers?: Record<string, string>) {
	return {
		status,
		ok: status >= 200 && status < 300,
		json: async () => body,
		text: async () => JSON.stringify(body),
		headers: { get: (name: string) => headers?.[name] ?? null },
	};
}

describe("transcribeAudioBlob", () => {
	test("posts multipart to transcriptions endpoint and returns text", async () => {
		const fetchMock = vi.fn(async (url: string, init: any) => {
			expect(url).toBe(
				"https://api.siliconflow.cn/v1/audio/transcriptions",
			);
			expect(init.headers.Authorization).toBe("Bearer sk-test");
			expect(init.body).toBeInstanceOf(FormData);
			expect(init.body.get("model")).toBe("Qwen/Qwen3-ASR-1.7B");
			return jsonResponse({ text: "你好" });
		});
		vi.stubGlobal("fetch", fetchMock);
		const text = await transcribeAudioBlob(
			new ArrayBuffer(10),
			"audio/wav",
			"chunk.wav",
			SETTINGS as any,
		);
		expect(text).toBe("你好");
		vi.unstubAllGlobals();
	});

	test("retries 429 with long backoff then succeeds", async () => {
		let calls = 0;
		const fetchMock = vi.fn(async () => {
			calls += 1;
			return calls < 3
				? jsonResponse({ error: "rate" }, 429)
				: jsonResponse({ text: "ok" });
		});
		vi.stubGlobal("fetch", fetchMock);
		vi.useFakeTimers();
		try {
			const pending = transcribeAudioBlob(
				new ArrayBuffer(10),
				"audio/wav",
				"c.wav",
				SETTINGS as any,
			);
			await vi.advanceTimersByTimeAsync(10_000);
			const text = await pending;
			expect(text).toBe("ok");
			expect(calls).toBe(3);
		} finally {
			vi.useRealTimers();
			vi.unstubAllGlobals();
		}
	});

	test("honors Retry-After header on 429", async () => {
		let calls = 0;
		const fetchMock = vi.fn(async () => {
			calls += 1;
			return calls === 1
				? jsonResponse({ error: "rate" }, 429, { "retry-after": "2" })
				: jsonResponse({ text: "ok" });
		});
		vi.stubGlobal("fetch", fetchMock);
		vi.useFakeTimers();
		try {
			const pending = transcribeAudioBlob(
				new ArrayBuffer(10),
				"audio/wav",
				"c.wav",
				SETTINGS as any,
			);
			await vi.advanceTimersByTimeAsync(2_000);
			const text = await pending;
			expect(text).toBe("ok");
			expect(calls).toBe(2);
		} finally {
			vi.useRealTimers();
			vi.unstubAllGlobals();
		}
	});

	test("429 exhausts after 5 attempts with readable error", async () => {
		const fetchMock = vi.fn(async () =>
			jsonResponse({ error: "rate" }, 429),
		);
		vi.stubGlobal("fetch", fetchMock);
		vi.useFakeTimers();
		try {
			const pending = transcribeAudioBlob(
				new ArrayBuffer(10),
				"audio/wav",
				"c.wav",
				SETTINGS as any,
			);
			await expect(
				vi.advanceTimersByTimeAsync(60_000).then(() => pending),
			).rejects.toThrow("转写连续失败（HTTP 429）");
			expect(fetchMock).toHaveBeenCalledTimes(5);
		} finally {
			vi.useRealTimers();
			vi.unstubAllGlobals();
		}
	});

	test("drops prompt after a 400 and stops sending it for the session", async () => {
		let calls = 0;
		const fetchMock = vi.fn(async (_url: string, init: any) => {
			calls += 1;
			if (init.body.get("prompt")) {
				return jsonResponse({ error: "unknown field" }, 400);
			}
			return jsonResponse({ text: "ok" });
		});
		vi.stubGlobal("fetch", fetchMock);
		await transcribeAudioBlob(
			new ArrayBuffer(10),
			"audio/wav",
			"c.wav",
			SETTINGS as any,
			{ prompt: "热词上下文" },
		);
		// 会话记忆：第二次调用不再携带 prompt，直接成功
		await transcribeAudioBlob(
			new ArrayBuffer(10),
			"audio/wav",
			"c2.wav",
			SETTINGS as any,
			{ prompt: "热词上下文" },
		);
		// 第一次：400（带 prompt）+ 重试成功；第二次：直接成功
		expect(calls).toBe(3);
		vi.unstubAllGlobals();
	});

	test("network failures retry with long backoff then succeed", async () => {
		let calls = 0;
		const fetchMock = vi.fn(async () => {
			calls += 1;
			if (calls < 3) throw new TypeError("Failed to fetch");
			return jsonResponse({ text: "ok" });
		});
		vi.stubGlobal("fetch", fetchMock);
		vi.useFakeTimers();
		try {
			const pending = transcribeAudioBlob(
				new ArrayBuffer(10),
				"audio/wav",
				"c.wav",
				SETTINGS as any,
			);
			await vi.advanceTimersByTimeAsync(20_000);
			const text = await pending;
			expect(text).toBe("ok");
			expect(calls).toBe(3);
		} finally {
			vi.useRealTimers();
			vi.unstubAllGlobals();
		}
	});

	test("fails fast on 401 with readable message", async () => {
		const fetchMock = vi.fn(async () =>
			jsonResponse({ message: "bad key" }, 401),
		);
		vi.stubGlobal("fetch", fetchMock);
		await expect(
			transcribeAudioBlob(
				new ArrayBuffer(10),
				"audio/wav",
				"c.wav",
				SETTINGS as any,
			),
		).rejects.toThrow("API Key 无效或余额不足");
		expect(fetchMock).toHaveBeenCalledTimes(1);
		vi.unstubAllGlobals();
	});
});
