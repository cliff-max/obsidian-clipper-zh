import { describe, expect, test, vi } from "vitest";
import {
	buildChunkPlan,
	fetchBilibiliAudioStream,
	findMoofOffsets,
	parseSidxFragmentOffsets,
	scanMoofBoxes,
} from "./bilibili-audio";

vi.mock("./browser-polyfill", () => ({
	default: {
		runtime: {
			sendMessage: vi.fn(),
		},
	},
}));

import browser from "./browser-polyfill";

function box(type: string, payloadLen: number): Uint8Array {
	const buf = new Uint8Array(8 + payloadLen);
	new DataView(buf.buffer).setUint32(0, buf.length, false);
	for (let i = 0; i < 4; i++) {
		buf[4 + i] = type.charCodeAt(i);
	}
	return buf;
}

function concat(...parts: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let off = 0;
	for (const p of parts) {
		out.set(p, off);
		off += p.length;
	}
	return out;
}

describe("findMoofOffsets", () => {
	test("walks the box chain and finds every moof", () => {
		const ftyp = box("ftyp", 4);
		const moov = box("moov", 16);
		const moof1 = box("moof", 32);
		const mdat1 = box("mdat", 64);
		const moof2 = box("moof", 32);
		const bytes = concat(ftyp, moov, moof1, mdat1, moof2);
		const base = ftyp.length + moov.length;
		expect(findMoofOffsets(bytes)).toEqual([
			base,
			base + moof1.length + mdat1.length,
		]);
	});

	test("does not match fake moof magic inside mdat payload", () => {
		const moof = box("moof", 8);
		const mdat = box("mdat", 12);
		// mdat 载荷中埋入伪 moof ASCII + 非法 size
		mdat.set([0, 0, 0, 99, 0x6d, 0x6f, 0x6f, 0x66, 0, 0, 0, 0], 8);
		const bytes = concat(moof, mdat);
		expect(findMoofOffsets(bytes)).toEqual([0]);
	});

	test("stops at truncated box", () => {
		const moof = box("moof", 8);
		const tail = new Uint8Array([0, 0, 0, 200]);
		expect(findMoofOffsets(concat(moof, tail))).toEqual([0]);
	});
});

describe("scanMoofBoxes", () => {
	test("reports chain end at the first incomplete box", () => {
		const moof1 = box("moof", 8);
		const mdat = box("mdat", 16);
		const truncated = new Uint8Array([0, 0, 0, 200, 1, 2, 3]);
		const bytes = concat(moof1, mdat, truncated);
		const scan = scanMoofBoxes(bytes);
		expect(scan.offsets).toEqual([0]);
		expect(scan.end).toBe(moof1.length + mdat.length);
	});
});

describe("parseSidxFragmentOffsets", () => {
	function sidxBox(
		sizes: number[],
		firstOffset = 0,
	): Uint8Array {
		const payloadLen = 22 + sizes.length * 12;
		const buf = box("sidx", payloadLen);
		const view = new DataView(buf.buffer);
		view.setUint8(8, 0); // version 0
		view.setUint32(12, 1, false); // reference_ID
		view.setUint32(16, 1000, false); // timescale
		view.setUint32(20, 0, false); // earliest_presentation_time
		view.setUint32(24, firstOffset, false); // first_offset
		view.setUint16(28, sizes.length, false);
		sizes.forEach((size, i) => {
			const at = 30 + i * 12;
			view.setUint32(at, size & 0x7fffffff, false);
			view.setUint32(at + 4, 1000, false); // subsegment_duration
			view.setUint32(at + 8, 0x90000000, false); // starts_with_SAP
		});
		return buf;
	}

	test("expands sidx references into absolute fragment offsets", () => {
		const ftyp = box("ftyp", 4);
		const moov = box("moov", 8);
		const sidx = sidxBox([100, 200, 300]);
		const bytes = concat(ftyp, moov, sidx);
		const result = parseSidxFragmentOffsets(bytes)!;
		const sidxEnd = ftyp.length + moov.length + sidx.length;
		expect(result.initEnd).toBe(sidxEnd);
		expect(result.offsets).toEqual([
			sidxEnd,
			sidxEnd + 100,
			sidxEnd + 300,
		]);
	});

	test("respects first_offset relative to sidx end", () => {
		const sidx = sidxBox([50], 10);
		const bytes = concat(box("ftyp", 4), sidx);
		const result = parseSidxFragmentOffsets(bytes)!;
		const sidxEnd = bytes.length;
		expect(result.offsets).toEqual([sidxEnd + 10]);
	});

	test("returns null when no sidx present", () => {
		expect(
			parseSidxFragmentOffsets(concat(box("ftyp", 4), box("moov", 8))),
		).toBeNull();
	});
});

describe("buildChunkPlan", () => {
	test("groups fragments into byte-bounded chunks with time estimates", () => {
		// 64kbps：64000/8 = 8000 B/s。init=64B，fragment 起点 64/4064/8064，总长 12064
		const plan = buildChunkPlan([64, 4064, 8064], 12064, 64, 8000, 64000);
		expect(plan).toEqual([
			{ start: 64, end: 8064, startSec: 0, durationSec: 1 },
			{ start: 8064, end: 12064, startSec: 1, durationSec: 0.5 },
		]);
	});

	test("empty offsets yield empty plan", () => {
		expect(buildChunkPlan([], 100, 100, 8000, 64000)).toEqual([]);
	});

	test("hard-splits sparse fragments beyond maxBlockBytes", () => {
		// 单个巨型 fragment（30000B）超过 maxBlockBytes(10000)：必须硬拆，
		// 否则巨型块解码响应会超出扩展消息 64MiB 上限
		const plan = buildChunkPlan(
			[0],
			30000,
			0,
			8000,
			64000,
			10000,
		);
		expect(plan.map((p) => [p.start, p.end])).toEqual([
			[0, 10000],
			[10000, 20000],
			[20000, 30000],
		]);
		// 所有块都不超过硬上限
		expect(
			plan.every((p) => p.end - p.start <= 10000),
		).toBe(true);
	});
});

describe("fetchBilibiliAudioStream", () => {
	test("picks 64kbps track (id 30232) with fallback to lowest bandwidth", async () => {
		const sendMessage = vi.mocked(browser.runtime.sendMessage);
		sendMessage.mockReset();
		sendMessage.mockImplementation(async (message: any) => {
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
				message.action === "fetchBilibiliJsonWithCookies" &&
				message.url.includes("playurl")
			) {
				return {
					success: true,
					data: {
						code: 0,
						data: {
							timelength: 6646000000,
							dash: {
								audio: [
									{
										id: 30280,
										baseUrl: "https://upos.example/a.m4s",
										bandwidth: 320000,
									},
									{
										id: 30232,
										baseUrl: "https://upos.example/64k.m4s",
										bandwidth: 64000,
									},
								],
							},
						},
					},
				};
			}
			throw new Error(`unexpected ${message.action}`);
		});
			const stream = await fetchBilibiliAudioStream({
				aid: 1,
				bvid: "BV1test",
				cid: 2,
			});
			expect(stream.url).toBe("https://upos.example/64k.m4s");
			expect(stream.bitrateBps).toBe(64000);
			expect(stream.urls).toEqual(["https://upos.example/64k.m4s"]);
		const call = sendMessage.mock.calls.find(
			([m]: any[]) => m.action === "fetchBilibiliJsonWithCookies",
		) as any[];
		expect(call[0].url).toContain("fnval=16");
		expect(call[0].url).toMatch(/w_rid=[0-9a-f]{32}/);
	});

	test("throws readable error when no audio track", async () => {
		const sendMessage = vi.mocked(browser.runtime.sendMessage);
		sendMessage.mockReset();
		sendMessage.mockImplementation(async (message: any) => {
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
			if (message.action === "fetchBilibiliJsonWithCookies") {
				return {
					success: true,
					data: { code: 0, data: { dash: { audio: [] } } },
				};
			}
			throw new Error(`unexpected ${message.action}`);
		});
		await expect(
			fetchBilibiliAudioStream({ aid: 1, bvid: "BV1t", cid: 2 }),
		).rejects.toThrow("无可用音频流");
	});
});
