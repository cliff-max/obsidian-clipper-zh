import { describe, expect, test } from 'vitest';
import { getWbiKeys, md5, resetWbiKeysCache, signWbiQuery } from './bilibili-wbi';

describe('md5', () => {
	test('matches reference digests', () => {
		expect(md5('')).toBe('d41d8cd98f00b204e9800998ecf8427e');
		expect(md5('abc')).toBe('900150983cd24fb0d6963f7d28e17f72');
		expect(md5('The quick brown fox jumps over the lazy dog')).toBe('9e107d9d372bb6826bd81d3542a419d6');
	});

	test('handles utf-8 input', () => {
		expect(md5('中文')).toBe('a7bac2239fcdcb3a067903d8077c4a07');
	});
});

describe('signWbiQuery', () => {
	const keys = {
		imgKey: '7cd084941338484aae1ad9425b84077c',
		subKey: '4932caff0ff74675b6ecd3d1519e7b76'
	};

	test('produces the reference signature from bilibili-API-collect example', () => {
		// 期望值由独立 Python 参考实现（mixin 重排 + urlencode 排序 + md5）计算
		const query = signWbiQuery(
			{ foo: '114', bar: '514', baz: '1919810' },
			keys,
			1702204800 * 1000
		);
		expect(query).toBe('bar=514&baz=1919810&foo=114&wts=1702204800&w_rid=f7f5c60c03b5ed67f6d7505f4e92b8df');
	});
});

describe('getWbiKeys', () => {
	test('extracts keys from nav response and caches them', async () => {
		resetWbiKeysCache();
		const calls: string[] = [];
		const fetchJson = async (url: string) => {
			calls.push(url);
			return {
				data: {
					wbi_img: {
						img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
						sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff74675b6ecd3d1519e7b76.png'
					}
				}
			};
		};

		const first = await getWbiKeys(fetchJson);
		expect(first).toEqual({
			imgKey: '7cd084941338484aae1ad9425b84077c',
			subKey: '4932caff0ff74675b6ecd3d1519e7b76'
		});

		const second = await getWbiKeys(fetchJson);
		expect(second).toEqual(first);
		expect(calls).toHaveLength(1);

		resetWbiKeysCache();
	});

	test('returns null when nav response has no wbi_img', async () => {
		resetWbiKeysCache();
		const result = await getWbiKeys(async () => ({ data: {} }));
		expect(result).toBeNull();
		resetWbiKeysCache();
	});
});
