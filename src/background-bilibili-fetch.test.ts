import { describe, expect, test, vi } from "vitest";
import { fetchBilibiliRangeDirect } from "./background-bilibili-fetch";

vi.mock("./utils/browser-polyfill", () => ({
	default: {
		runtime: { sendMessage: vi.fn() },
		cookies: { getAll: vi.fn(async () => []) },
	},
}));

function makeBuffer(length: number): ArrayBuffer {
	const bytes = new Uint8Array(length);
	for (let i = 0; i < length; i++) bytes[i] = i % 251;
	return bytes.buffer;
}

describe("fetchBilibiliRangeDirect", () => {
	test("trims a 200 full-body response to the requested range", async () => {
		const full = makeBuffer(1000);
		const fetchMock = vi.fn(async () => ({
			ok: true,
			status: 200,
			arrayBuffer: async () => full.slice(0),
		}));
		vi.stubGlobal("fetch", fetchMock);
		const out = await fetchBilibiliRangeDirect(
			"https://upos-sy.bilivideo.com/a.m4s",
			100,
			199,
		);
		vi.unstubAllGlobals();
		expect(out.byteLength).toBe(100);
		const view = new Uint8Array(out);
		expect(view[0]).toBe(100 % 251);
		expect(view[99]).toBe(199 % 251);
	});

	test("passes a 206 partial response through untouched", async () => {
		const partial = makeBuffer(50);
		const fetchMock = vi.fn(async () => ({
			ok: true,
			status: 206,
			arrayBuffer: async () => partial.slice(0),
		}));
		vi.stubGlobal("fetch", fetchMock);
		const out = await fetchBilibiliRangeDirect(
			"https://upos-sy.bilivideo.com/a.m4s",
			7,
			56,
		);
		vi.unstubAllGlobals();
		expect(out.byteLength).toBe(50);
	});

	test("rejects urls outside the allowlist", async () => {
		await expect(
			fetchBilibiliRangeDirect("https://evil.example/a.m4s", 0, 10),
		).rejects.toThrow("Blocked");
	});

	test("403 retries once with dnr-injected origin header", async () => {
		let calls = 0;
		const updateSessionRules = vi.fn(async () => {});
		(globalThis as any).chrome = {
			declarativeNetRequest: { updateSessionRules },
		};
		const partial = makeBuffer(30);
		const fetchMock = vi.fn(async () => {
			calls += 1;
			if (calls === 1) {
				return { ok: false, status: 403, arrayBuffer: async () => partial };
			}
			return {
				ok: true,
				status: 206,
				arrayBuffer: async () => partial.slice(0),
			};
		});
		vi.stubGlobal("fetch", fetchMock);
		try {
			const out = await fetchBilibiliRangeDirect(
				"https://upos-sz.bilivideo.com/a.m4s",
				0,
				29,
			);
			expect(out.byteLength).toBe(30);
			expect(calls).toBe(2);
			expect(updateSessionRules).toHaveBeenCalled();
			// 注入规则里带 Origin（页面同源请求特征）
			const addCall = (
				updateSessionRules.mock.calls as any[][]
			).find((args) => args[0]?.addRules?.length);
			const headers =
				addCall?.[0]?.addRules?.[0]?.action?.requestHeaders ?? [];
			expect(
				headers.some(
					(h: any) =>
						h.header === "Origin" &&
						h.value === "https://www.bilibili.com",
				),
			).toBe(true);
		} finally {
			delete (globalThis as any).chrome;
			vi.unstubAllGlobals();
		}
	});

	test("non-403 failures are not retried with header rules", async () => {
		const fetchMock = vi.fn(async () => ({
			ok: false,
			status: 500,
			arrayBuffer: async () => makeBuffer(1),
		}));
		vi.stubGlobal("fetch", fetchMock);
		await expect(
			fetchBilibiliRangeDirect(
				"https://upos-sz.bilivideo.com/a.m4s",
				0,
				10,
			),
		).rejects.toThrow("status 500");
		expect(fetchMock).toHaveBeenCalledTimes(1);
		vi.unstubAllGlobals();
	});
});
