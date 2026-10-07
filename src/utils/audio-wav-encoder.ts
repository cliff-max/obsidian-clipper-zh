/**
 * 将 16kHz 单声道浮点采样编码为 16-bit PCM WAV。
 */
export function encodeWav(
	samples: Float32Array,
	sampleRate: number,
): ArrayBuffer {
	const bytesPerSample = 2;
	const dataSize = samples.length * bytesPerSample;
	const buffer = new ArrayBuffer(44 + dataSize);
	const view = new DataView(buffer);
	const writeAscii = (offset: number, text: string) => {
		for (let i = 0; i < text.length; i++) {
			view.setUint8(offset + i, text.charCodeAt(i));
		}
	};
	writeAscii(0, "RIFF");
	view.setUint32(4, 36 + dataSize, true);
	writeAscii(8, "WAVE");
	writeAscii(12, "fmt ");
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, 1, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * bytesPerSample, true);
	view.setUint16(32, bytesPerSample, true);
	view.setUint16(34, 16, true);
	writeAscii(36, "data");
	view.setUint32(40, dataSize, true);
	let offset = 44;
	for (let i = 0; i < samples.length; i++) {
		const clamped = Math.max(-1, Math.min(1, samples[i]));
		view.setInt16(
			offset,
			clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff,
			true,
		);
		offset += 2;
	}
	return buffer;
}

/**
 * 在页面上下文解码任意音频容器（m4s/AAC）并重采样为 16kHz 单声道 WAV。
 * 依赖 AudioContext，只能在 content script / 页面环境调用。
 */
export async function decodeAudioToWav(
	arrayBuffer: ArrayBuffer,
): Promise<ArrayBuffer> {
	const ctx = new AudioContext();
	try {
		const decoded = await ctx.decodeAudioData(arrayBuffer.slice(0));
		const offline = new OfflineAudioContext(
			1,
			Math.max(1, Math.ceil(decoded.duration * 16000)),
			16000,
		);
		const source = offline.createBufferSource();
		source.buffer = decoded;
		source.connect(offline.destination);
		source.start();
		const rendered = await offline.startRendering();
		return encodeWav(rendered.getChannelData(0), 16000);
	} finally {
		void ctx.close();
	}
}
