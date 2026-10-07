import { describe, expect, test, vi } from "vitest";
import { transcribeAudioBlob } from "./transcribe-client";

const SETTINGS = {
	enabled: true,
	apiKey: "sk-test",
	model: "Qwen/Qwen3-ASR-1.7B",
	baseUrl: "https://api.siliconflow.cn",
};

function jsonResponse(body: any, status = 200) {
	return {
		status,
		ok: status >= 200 && status < 300,
		json: async () => body,
		text: async () => JSON.stringify(body),
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

	test("retries 429 twice then succeeds", async () => {
		let calls = 0;
		const fetchMock = vi.fn(async () => {
			calls += 1;
			return calls < 3
				? jsonResponse({ error: "rate" }, 429)
				: jsonResponse({ text: "ok" });
		});
		vi.stubGlobal("fetch", fetchMock);
		const text = await transcribeAudioBlob(
			new ArrayBuffer(10),
			"audio/wav",
			"c.wav",
			SETTINGS as any,
		);
		expect(text).toBe("ok");
		expect(calls).toBe(3);
		vi.unstubAllGlobals();
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
