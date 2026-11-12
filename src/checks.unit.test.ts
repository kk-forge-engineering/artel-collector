import { describe, expect, it } from 'vitest';
import { checkEvent, checkOptions, isTestKey, newCollector, newMemoryStorage, Platform } from './exports.js';
import { ENDPOINT, KEY, VERSION } from '../tests/harness.js';
import { fromUntypedHost } from '../tests/untypedHost.js';

const OPTIONS = { key: KEY, version: VERSION, endpoint: ENDPOINT, platform: Platform.Extension } as const;

/** Returns what `run` throws, or undefined. */
function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('checkOptions', () => {
  it('returns for options a constructor takes', () => {
    expect(checkOptions(OPTIONS)).toBeUndefined();
    const { endpoint: _endpoint, ...withoutEndpoint } = OPTIONS;
    expect(checkOptions({ ...withoutEndpoint, transport: async () => 204 })).toBeUndefined();
  });

  it.each([
    ['a key of another form', { key: 'extension-AA' }],
    ['a key whose kind does not take the platform', { key: 'site-aa131n3j11' }],
    ['a version the intake does not take', { version: '1.2.3.4.5' }],
    ['an endpoint that is not https', { endpoint: 'http://intake.example.com/v1/public/relay' }],
    ['a platform the intake does not take', { platform: 'ios' }],
  ])('throws the TypeError the constructor throws for %s', (_case, change) => {
    const options = fromUntypedHost<typeof OPTIONS>({ ...OPTIONS, ...change });
    const fromConstructor = thrownBy(() =>
      newCollector({ ...options, storage: newMemoryStorage(), mode: 'anonymous' }),
    );

    expect(fromConstructor).toBeInstanceOf(TypeError);
    expect(thrownBy(() => checkOptions(options))).toEqual(fromConstructor);
  });
});

describe('isTestKey', () => {
  it.each([
    ['extension-test-aa131n3j11', true],
    ['site-test-aa131n3j11', true],
    ['desktop-test-aa131n3j11', true],
    ['extension-aa131n3j11', false],
    ['extension-test-AA131N3J11', false],
    ['phone-test-aa131n3j11', false],
  ])('reads %s as a test key: %s', (key, isTest) => {
    expect(isTestKey(key)).toBe(isTest);
  });
});

describe('checkEvent', () => {
  it.each([
    ['report_exported', { format: 'pdf' }, undefined],
    ['Report', undefined, 'has a name the intake does not take'],
    ['installed', undefined, 'is one only the collector sends'],
  ])('returns the problem of %s, as track finds it', (name, params, problem) => {
    expect(checkEvent(name, params)).toBe(problem);
  });

  it.each([
    [
      'a getter that throws',
      {
        get boom(): string {
          throw new Error('getter');
        },
      },
    ],
    [
      'a proxy whose keys throw',
      new Proxy(
        {},
        {
          ownKeys: () => {
            throw new Error('keys');
          },
        },
      ),
    ],
  ])('returns that params with %s could not be read, and never throws', (_case, params) => {
    expect(checkEvent('report_exported', params)).toBe('has params that could not be read');
  });
});
