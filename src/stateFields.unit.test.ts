import { describe, expect, it } from 'vitest';
import { AnalyticsState, Platform } from './exports.js';
import { fieldsForState } from './stateFields.js';

describe('fieldsForState shaping', () => {
  it.each([
    [AnalyticsState.Identified, 'pt-BR', 'zh-Hant-TW', true],
    [AnalyticsState.Anonymous, 'pt', 'zh', false],
    [AnalyticsState.OptedOut, 'pt', 'zh', false],
  ])('in the %s state sends the languages as %s and %s, with exact ages %s', (state, browser, ui, isAgeExact) => {
    const fields = fieldsForState({
      state,
      build: { platform: Platform.Web, version: '1.0.0' },
      browserLanguage: 'pt-BR',
      uiLanguage: 'zh-Hant-TW',
    });

    expect([fields.product.browser_language, fields.product.ui_language, fields.isAgeExact]).toEqual([
      browser,
      ui,
      isAgeExact,
    ]);
  });
});
