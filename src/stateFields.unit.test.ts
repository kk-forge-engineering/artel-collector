import { describe, expect, it } from "vitest";
import { AnalyticsState, Platform } from "./exports.js";
import { fieldsForState } from "./stateFields.js";

describe("fieldsForState shaping", () => {
  it.each([
    [AnalyticsState.Identified, "pt-BR", "zh-Hant-TW", true, "identified"],
    [AnalyticsState.Pseudonymous, "pt-BR", "zh-Hant-TW", true, "pseudonymous"],
    [AnalyticsState.Anonymous, "pt", "zh", false, undefined],
    [AnalyticsState.OptedOut, "pt", "zh", false, undefined],
  ])(
    "in the %s state sends the languages as %s and %s, with exact ages %s and an id of kind %s",
    (state, browser, ui, isAgeExact, idKind) => {
      const fields = fieldsForState({
        state,
        build: { platform: Platform.Web, version: "1.0.0" },
        browserLanguage: "pt-BR",
        uiLanguage: "zh-Hant-TW",
      });

      expect([
        fields.product.browser_language,
        fields.product.ui_language,
        fields.isAgeExact,
        fields.idKind,
      ]).toEqual([browser, ui, isAgeExact, idKind]);
    },
  );
});
