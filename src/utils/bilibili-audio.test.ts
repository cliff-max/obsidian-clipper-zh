import { describe, expect, test } from "vitest";
import { buildChunkPlan, findMoofOffsets } from "./bilibili-audio";

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
});
