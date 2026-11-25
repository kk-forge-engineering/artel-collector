import { describe, expect, it } from "vitest";
import { trackPageView, trackPageViews } from "./web.js";
import { Platform } from "../shared/exports.js";
import { newHarness } from "#tests/harness.js";
import { newHashRouteHarness, pageViews, stubPage } from "#tests/fakePage.js";

describe("trackPageView", () => {
  it("sends page_view for the screen getPage gives, for a router that keeps the address", async () => {
    stubPage();
    let screen = "/inbox";
    const harness = newHarness({ platform: Platform.Web, getPage: () => ({ page: screen }) });

    trackPageViews(harness.collector);
    screen = "/settings";
    await trackPageView(harness.collector);
    screen = "/inbox";
    await trackPageView(harness.collector);
    await harness.settle();

    expect(pageViews(harness).map(([path]) => path)).toEqual(["/inbox", "/settings", "/inbox"]);
  });

  it("sends nothing for the page the last page_view sent, whether a navigation or a call sent it", async () => {
    stubPage();
    const harness = newHashRouteHarness();

    trackPageViews(harness.collector);
    await trackPageView(harness.collector);
    history.pushState({}, "", "#ideas/1");
    await trackPageView(harness.collector);
    await harness.settle();

    expect(pageViews(harness).map(([path]) => path)).toEqual(["/", "/ideas/:id"]);
  });

  it("counts a navigation back to the page a call left", async () => {
    stubPage();
    let screen = "/a";
    const harness = newHarness({ platform: Platform.Web, getPage: () => ({ page: screen }) });

    trackPageViews(harness.collector);
    screen = "/settings";
    await trackPageView(harness.collector);
    screen = "/a";
    history.pushState({}, "", "/a");
    await harness.settle();

    expect(pageViews(harness).map(([path]) => path)).toEqual(["/a", "/settings", "/a"]);
  });

  it("sends the page a tracker started again on, after the user left opted_out", async () => {
    stubPage();
    const harness = newHarness({
      platform: Platform.Web,
      getPage: () => ({ page: location.pathname }),
    });

    await harness.collector.setState("opted_out");
    trackPageViews(harness.collector)();
    await harness.collector.setState("anonymous");
    trackPageViews(harness.collector);
    await harness.settle();

    expect(pageViews(harness).map(([path]) => path)).toEqual(["/"]);
  });

  it("carries the referring host when it sends the first page_view of a load", async () => {
    stubPage();
    const harness = newHarness({
      platform: Platform.Web,
      getPage: () => ({ page: "/inbox", referrer: document.referrer }),
    });

    await trackPageView(harness.collector);
    await harness.settle();

    expect(pageViews(harness)).toEqual([["/inbox", "www.google.com"]]);
  });
});
