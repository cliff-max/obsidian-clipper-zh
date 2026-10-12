import { describe, expect, test } from "vitest";
import {
	computeFrameRms,
	encodeWav,
	findSilenceCutPoints,
	planTranscribeSlices,
	realignFragmentedAudio,
	splitWavInHalf,
} from "./audio-wav-encoder";

function mp4Box(type: string, payloadLen: number, fill = 0): Uint8Array {
	const buf = new Uint8Array(8 + payloadLen);
	new DataView(buf.buffer).setUint32(0, buf.length, false);
	for (let i = 0; i < 4; i++) buf[4 + i] = type.charCodeAt(i);
	if (fill) buf.fill(fill, 8);
	return buf;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
}

function readAscii(view: DataView, offset: number, length: number): string {
	let s = "";
	for (let i = 0; i < length; i++) {
		s += String.fromCharCode(view.getUint8(offset + i));
	}
	return s;
}

describe("encodeWav", () => {
	test("writes canonical 44-byte PCM header", () => {
		const buf = encodeWav(new Float32Array([0, 0.5, -0.5, 1, -1]), 16000);
		const view = new DataView(buf);
		expect(buf.byteLength).toBe(44 + 10);
		expect(readAscii(view, 0, 4)).toBe("RIFF");
		expect(readAscii(view, 8, 4)).toBe("WAVE");
		expect(readAscii(view, 12, 4)).toBe("fmt ");
		expect(view.getUint32(16, true)).toBe(16);
		expect(view.getUint16(20, true)).toBe(1);
		expect(view.getUint16(22, true)).toBe(1);
		expect(view.getUint32(24, true)).toBe(16000);
		expect(view.getUint32(28, true)).toBe(32000);
		expect(view.getUint16(34, true)).toBe(16);
		expect(readAscii(view, 36, 4)).toBe("data");
		expect(view.getUint32(40, true)).toBe(10);
	});

	test("clamps amplitudes into int16 range", () => {
		const buf = encodeWav(new Float32Array([0, 1, -1, 2, -2]), 16000);
		const view = new DataView(buf);
		expect(view.getInt16(44, true)).toBe(0);
		expect(view.getInt16(46, true)).toBe(0x7fff);
		expect(view.getInt16(48, true)).toBe(-0x8000);
		expect(view.getInt16(50, true)).toBe(0x7fff);
		expect(view.getInt16(52, true)).toBe(-0x8000);
	});

	test("empty samples produce header only", () => {
		expect(encodeWav(new Float32Array(0), 16000).byteLength).toBe(44);
	});
});

describe("VAD 静音切分", () => {
	const SR = 16000;

	test("computeFrameRms measures per-frame energy", () => {
		// 1 帧静音 + 1 帧满幅
		const samples = new Float32Array(SR * 0.025 * 2);
		samples.fill(0.5, SR * 0.025);
		const rms = computeFrameRms(samples, SR, 0.025, 0.025);
		expect(rms).toHaveLength(2);
		expect(rms[0]).toBeCloseTo(0, 5);
		expect(rms[1]).toBeCloseTo(0.5, 5);
	});

	test("findSilenceCutPoints returns midpoints of sustained silence", () => {
		const frameRms = new Float32Array(100);
		frameRms.fill(0.5);
		// 第 40~60 帧静音（0.2s @10ms hop = 20 帧 < 30 帧不算）
		frameRms.fill(0, 40, 60);
		// 第 70 帧起持续静音到结尾
		frameRms.fill(0, 70);
		const cuts = findSilenceCutPoints(new Float32Array(SR * 5), SR, frameRms, {
			targetSec: 30,
			minSec: 10,
			maxSec: 45,
			frameSec: 0.025,
			hopSec: 0.01,
			minSilenceSec: 0.3,
			silenceThresholdRatio: 0.1,
		});
		// 仅 70~100 帧的静音段（30 帧）构成切点，中点第 85 帧
		expect(cuts).toHaveLength(1);
		expect(cuts[0]).toBe(85 * 160);
	});

	test("slices cut at silence near the 30s target", () => {
		// 70s 音频：0~29s 满幅、29~31s 静音、31~70s 满幅
		const samples = new Float32Array(SR * 70);
		samples.fill(0.6);
		samples.fill(0, SR * 29, SR * 31);
		const plans = planTranscribeSlices(samples, SR);
		expect(plans).toHaveLength(2);
		// 切点取静音段中点（30s）
		expect(plans[0].durationSec).toBeCloseTo(30, 1);
		expect(plans[1].durationSec).toBeCloseTo(40, 1);
		expect(plans[0].startSample).toBe(0);
		// 细块拼接无遗漏
		const total = plans.reduce((n, p) => n + p.sampleCount, 0);
		expect(total).toBe(samples.length);
	});

	test("no silence available → hard cut at target", () => {
		// 持续满幅 100s：能量均匀（无静音可切），按 30s 硬切
		const samples = new Float32Array(SR * 100);
		samples.fill(0.8);
		const plans = planTranscribeSlices(samples, SR);
		expect(plans).toHaveLength(3);
		expect(plans[0].durationSec).toBeCloseTo(30, 5);
		expect(plans[1].durationSec).toBeCloseTo(30, 5);
		// 递进：0-30, 30-60, 剩余 40s ≤ maxLen(45) → 独立成块
		expect(plans[2].durationSec).toBeCloseTo(40, 5);
	});

	test("short tail below minSec merges into previous slice", () => {
		// 65s：0-30、30-60 后剩 5s < min(10) 并入前块
		const samples = new Float32Array(SR * 65);
		samples.fill(0.8);
		const plans = planTranscribeSlices(samples, SR);
		expect(plans).toHaveLength(2);
		expect(plans[1].durationSec).toBeCloseTo(35, 5);
		const total = plans.reduce((n, p) => n + p.sampleCount, 0);
		expect(total).toBe(samples.length);
	});

	test("short input produces a single slice", () => {
		const samples = new Float32Array(SR * 8);
		const plans = planTranscribeSlices(samples, SR);
		expect(plans).toHaveLength(1);
		expect(plans[0].durationSec).toBeCloseTo(8, 5);
	});
});

describe("splitWavInHalf", () => {
	test("splits a canonical wav into two sample-aligned halves", () => {
		const samples = new Float32Array(1000);
		for (let i = 0; i < samples.length; i++) samples[i] = (i % 7) / 7;
		const wav = encodeWav(samples, 16000);
		const halves = splitWavInHalf(wav)!;
		expect(halves).toHaveLength(2);
		const readHeader = (buffer: ArrayBuffer) => {
			const view = new DataView(buffer);
			const ascii = (offset: number) =>
				String.fromCharCode(
					view.getUint8(offset),
					view.getUint8(offset + 1),
					view.getUint8(offset + 2),
					view.getUint8(offset + 3),
				);
			return {
				riffSize: view.getUint32(4, true),
				dataSize: view.getUint32(40, true),
				riff: ascii(0),
				data: ascii(36),
			};
		};
		const h1 = readHeader(halves[0]);
		const h2 = readHeader(halves[1]);
		expect(h1.riff).toBe("RIFF");
		expect(h1.data).toBe("data");
		// 两半数据量之和 = 原数据量（样本对齐，无损拼接）
		expect(h1.dataSize + h2.dataSize).toBe(1000 * 2);
		expect(halves[0].byteLength).toBe(44 + h1.dataSize);
		expect(halves[1].byteLength).toBe(44 + h2.dataSize);
		expect(h1.riffSize).toBe(36 + h1.dataSize);
	});

	test("returns null for non-canonical input", () => {
		expect(splitWavInHalf(new ArrayBuffer(10))).toBeNull();
		expect(splitWavInHalf(new TextEncoder().encode("not a wav").buffer))
			.toBeNull();
	});
});

describe("realignFragmentedAudio", () => {
	test("drops the partial box at the chain break and resumes from the first complete moof", () => {
		// init(ftyp+moov) + 半个 fragment 的内部字节 + 完整的 moof+mdat
		const ftyp = mp4Box("ftyp", 8);
		const moov = mp4Box("moov", 32, 1);
		const partialGarbage = new Uint8Array(120).fill(0xab); // 无 box 结构
		const moof = mp4Box("moof", 32, 2);
		const mdat = mp4Box("mdat", 64, 3);
		const combined = concatBytes(ftyp, moov, partialGarbage, moof, mdat);
		const realigned = realignFragmentedAudio(combined.buffer);
		const bytes = new Uint8Array(realigned);
		// 头部 init 完整保留，随后直接是 moof
		expect(bytes.byteLength).toBe(
			ftyp.length + moov.length + moof.length + mdat.length,
		);
		const head = bytes.subarray(0, ftyp.length + moov.length);
		expect(head).toEqual(concatBytes(ftyp, moov));
		const magic = (offset: number) =>
			String.fromCharCode(
				bytes[offset + 4],
				bytes[offset + 5],
				bytes[offset + 6],
				bytes[offset + 7],
			);
		expect(magic(ftyp.length + moov.length)).toBe("moof");
	});

	test("returns aligned input untouched", () => {
		const aligned = concatBytes(
			mp4Box("ftyp", 8),
			mp4Box("moov", 32, 1),
			mp4Box("moof", 32, 2),
			mp4Box("mdat", 64, 3),
		);
		const out = realignFragmentedAudio(aligned.buffer);
		expect(out).toBe(aligned.buffer);
	});

	test("skips an incomplete trailing moof and finds the next complete one", () => {
		// 断点后先出现一个 size 越界的假 moof，再出现完整 moof
		const ftyp = mp4Box("ftyp", 8);
		const moov = mp4Box("moov", 16, 1);
		const brokenMoof = mp4Box("moof", 32, 2);
		// 把它的 size 改成超出缓冲，制造"不完整 moof"
		new DataView(brokenMoof.buffer).setUint32(0, 10_000, false);
		const goodMoof = mp4Box("moof", 40, 4);
		const mdat = mp4Box("mdat", 32, 5);
		const combined = concatBytes(ftyp, moov, brokenMoof, goodMoof, mdat);
		const realigned = new Uint8Array(
			realignFragmentedAudio(combined.buffer),
		);
		// 链在 ftyp+moov 后断（brokenMoof size 越界），假 moof 被跳过
		expect(realigned.byteLength).toBe(
			ftyp.length + moov.length + goodMoof.length + mdat.length,
		);
		const magic = (offset: number) =>
			String.fromCharCode(
				realigned[offset + 4],
				realigned[offset + 5],
				realigned[offset + 6],
				realigned[offset + 7],
			);
		expect(magic(ftyp.length + moov.length)).toBe("moof");
		expect(realigned[ftyp.length + moov.length + 8]).toBe(4); // goodMoof 载荷
	});

	test("passes through audio without moof magic (mp3 等)", () => {
		const raw = new Uint8Array(500).fill(0x11);
		const out = realignFragmentedAudio(raw.buffer);
		expect(out).toBe(raw.buffer);
	});
});
