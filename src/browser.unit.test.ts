import { describe, expect, it } from 'vitest';
import { detectBrowser } from './browser.js';

const CHROME_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

describe('detectBrowser', () => {
  it.each([
    [
      'Chrome',
      [
        { brand: 'Google Chrome', version: '131' },
        { brand: 'Chromium', version: '131' },
        { brand: 'Not_A Brand', version: '24' },
      ],
      { name: 'chrome', major: 131 },
    ],
    [
      'Edge',
      [
        { brand: 'Microsoft Edge', version: '130' },
        { brand: 'Not?A_Brand', version: '99' },
        { brand: 'Chromium', version: '130' },
      ],
      { name: 'edge', major: 130 },
    ],
    [
      'Opera',
      [
        { brand: 'Chromium', version: '128' },
        { brand: 'Not;A=Brand', version: '24' },
        { brand: 'Opera', version: '114' },
      ],
      { name: 'opera', major: 114 },
    ],
    [
      'Yandex',
      [
        { brand: 'Chromium', version: '128' },
        { brand: 'Not;A=Brand', version: '24' },
        { brand: 'YaBrowser', version: '24' },
        { brand: 'Yowser', version: '2.5' },
      ],
      { name: 'yandex', major: 24 },
    ],
    [
      'Brave',
      [
        { brand: 'Brave', version: '131' },
        { brand: 'Chromium', version: '131' },
        { brand: 'Not_A Brand', version: '24' },
      ],
      { name: 'brave', major: 131 },
    ],
    [
      'a Chromium browser without a brand of its own',
      [
        { brand: 'Chromium', version: '131' },
        { brand: 'Not_A Brand', version: '24' },
      ],
      { name: 'other' },
    ],
  ])('names %s from its brands', (_, brands, browser) => {
    expect(detectBrowser({ userAgent: CHROME_MAC, userAgentData: { brands } })).toEqual(browser);
  });

  it.each([
    [
      'Firefox',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:132.0) Gecko/20100101 Firefox/132.0',
      { name: 'firefox', major: 132 },
    ],
    [
      'Safari',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
      { name: 'safari', major: 18 },
    ],
    [
      'Safari on an iPhone',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
      { name: 'safari', major: 18 },
    ],
    [
      'Edge',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.2849.68',
      { name: 'edge', major: 130 },
    ],
    [
      'Opera',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 OPR/114.0.0.0',
      { name: 'opera', major: 114 },
    ],
    [
      'Yandex',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 YaBrowser/24.10.0.0 Safari/537.36',
      { name: 'yandex', major: 24 },
    ],
    ['Chrome, whose own token the User-Agent path leaves to its brands', CHROME_MAC, { name: 'other' }],
    [
      'Edge on an iPhone, which shows the tokens of Safari and no Chrome token',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 EdgiOS/131.2903.86 Mobile/15E148 Safari/605.1.15',
      { name: 'safari', major: 18 },
    ],
    [
      'Chrome on an iPhone',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.6778.73 Mobile/15E148 Safari/604.1',
      { name: 'other' },
    ],
    [
      'an Android WebView, which shows a Version token next to Chrome',
      'Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/131.0.6778.81 Mobile Safari/537.36',
      { name: 'other' },
    ],
    ['an unknown browser', 'curl/8.7.1', { name: 'other' }],
  ])('names %s from its User-Agent without brands', (_, userAgent, browser) => {
    expect(detectBrowser({ userAgent })).toEqual(browser);
  });

  it('reads the User-Agent when the brands list is empty', () => {
    const firefox = 'Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0';
    expect(detectBrowser({ userAgent: firefox, userAgentData: { brands: [] } })).toEqual({
      name: 'firefox',
      major: 132,
    });
  });

  it.each([
    ['its brands', { userAgentData: { brands: [{ brand: 'Google Chrome', version: '1000' }] } }, 'chrome'],
    ['its User-Agent', { userAgent: 'Mozilla/5.0 (X11; rv:1000.0) Gecko/20100101 Firefox/1000.0' }, 'firefox'],
    [
      'the Safari User-Agent',
      { userAgent: 'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/1000.0 Safari/605.1.15' },
      'safari',
    ],
  ])('names a browser whose major version in %s passes 999, without the version', (_, nav, name) => {
    expect(detectBrowser(nav)).toEqual({ name });
  });

  it('names a browser that lists both its own brand and Google Chrome by its own', () => {
    const brands = [
      { brand: 'Google Chrome', version: '130' },
      { brand: 'Microsoft Edge', version: '130' },
    ];
    expect(detectBrowser({ userAgentData: { brands } })).toEqual({ name: 'edge', major: 130 });
  });

  it('names a Chromium browser with no brand of its own other, without a User-Agent', () => {
    expect(detectBrowser({ userAgentData: { brands: [{ brand: 'Chromium', version: '131' }] } })).toEqual({
      name: 'other',
    });
  });

  it('names a browser from its brands without a User-Agent', () => {
    expect(detectBrowser({ userAgentData: { brands: [{ brand: 'Google Chrome', version: '131' }] } })).toEqual({
      name: 'chrome',
      major: 131,
    });
  });

  // The ratio of two input sizes holds under a loaded runner, where an absolute bound does not. Eight times the input
  // takes about eight times as long in linear time, and sixty-four times as long in quadratic time.
  it.each([
    ['many Version tokens', (size: number) => 'Version/1 '.repeat(size)],
    ['one Version token with a long digit run', (size: number) => 'Version/' + '9'.repeat(10 * size)],
  ])('reads a huge User-Agent of %s and no Safari token in linear time', (_, userAgentOf) => {
    /** Returns the least time of five reads of a User-Agent of `size`, in milliseconds. */
    function fastestMs(size: number): number {
      const userAgent = userAgentOf(size);
      let fastest = Infinity;
      for (let run = 0; run < 5; run++) {
        const start = performance.now();
        expect(detectBrowser({ userAgent })).toEqual({ name: 'other' });
        fastest = Math.min(fastest, performance.now() - start);
      }
      return fastest;
    }

    const small = fastestMs(6_400);
    const large = fastestMs(51_200);

    expect(large / Math.max(small, 0.05)).toBeLessThan(24);
  });

  it('answers undefined without brands and without a User-Agent', () => {
    expect(detectBrowser({})).toBeUndefined();
    expect(detectBrowser({ userAgent: '', userAgentData: { brands: [] } })).toBeUndefined();
  });
});
