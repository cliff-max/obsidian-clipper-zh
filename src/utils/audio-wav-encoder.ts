/**
 * ArrayBuffer ↔ base64：Chrome 扩展消息是 JSON 序列化的，ArrayBuffer 会
 * 变成空对象，音频字节必须以 base64 字符串过消息通道。
 */
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let binary = "";
	const CHUNK = 0x8000;
	for (let i = 0; i < bytes.length; i += CHUNK) {
		binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
	}
	return btoa(binary);
}

export function base64ToArrayBuffer(base64: string): ArrayBuffer {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes.buffer;
}

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
 * 共享解码上下文：Chrome 限制每页最多 6 个实时 AudioContext，
 * 并发解码时每次新建会超限（新 context 挂起、decodeAudioData 永不
 * resolve）。decodeAudioData 可在同一 context 上并发复用。
 */
let sharedDecodeContext: AudioContext | null = null;

function getDecodeContext(): AudioContext {
	if (!sharedDecodeContext || sharedDecodeContext.state === "closed") {
		sharedDecodeContext = new AudioContext();
	}
	if (sharedDecodeContext.state === "suspended") {
		void sharedDecodeContext.resume();
	}
	return sharedDecodeContext;
}

const DECODE_TIMEOUT_MS = 90 * 1000;

/**
 * 在页面上下文解码任意音频容器（m4s/AAC）并重采样为 16kHz 单声道 WAV。
 * 依赖 AudioContext，只能在 content script / 页面环境调用。
 * 解码超时抛错（调用方降级），避免消息通道被挂死。
 */
export async function decodeAudioToWav(
	arrayBuffer: ArrayBuffer,
): Promise<ArrayBuffer> {
	const ctx = getDecodeContext();
	const decodePromise = ctx.decodeAudioData(arrayBuffer.slice(0));
	const timeout = new Promise<never>((_, reject) =>
		setTimeout(() => reject(new Error("音频解码超时")), DECODE_TIMEOUT_MS),
	);
	const decoded = await Promise.race([decodePromise, timeout]);
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
}
