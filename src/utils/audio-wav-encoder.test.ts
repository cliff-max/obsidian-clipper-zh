import { describe, expect, test } from "vitest";
import { encodeWav } from "./audio-wav-encoder";

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
