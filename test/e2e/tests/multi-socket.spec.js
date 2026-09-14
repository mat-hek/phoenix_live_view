import { test, expect } from "@playwright/test";
import { syncLV } from "../utils";

// the embedded app's three roots: injected into the host's ignore slot,
// dead-rendered in the root layout, and rendered sticky by the main view
const nested = (page) => page.locator("#embed-slot [data-app=embedded]");

const outside = (page) =>
  page.locator("[data-app=embedded]:not(#embed-slot *):not([data-phx-sticky])");

const sticky = (page) => page.locator("#sticky-embedded");

const connectAll = async (page) => {
  await page.goto("/multi-socket");
  await syncLV(page);
  await expect(page.locator("[data-phx-session].phx-connected")).toHaveCount(4);
};

test("each socket joins exactly its own roots", async ({ page }) => {
  await connectAll(page);

  const mainIds = await page.evaluate(() =>
    Object.values(window.mainLiveSocket.roots).map((view) =>
      view.el.getAttribute("data-app"),
    ),
  );
  expect(mainIds).toEqual(["main"]);

  const embeddedApps = await page.evaluate(() =>
    Object.values(window.embeddedLiveSocket.roots).map((view) =>
      view.el.getAttribute("data-app"),
    ),
  );
  expect(embeddedApps).toEqual(["embedded", "embedded", "embedded"]);
  // one embedded root lives inside the host view's ignore slot
  const nestedJoined = await page.evaluate(() =>
    Object.values(window.embeddedLiveSocket.roots).map(
      (view) => !!view.el.closest("#embed-slot"),
    ),
  );
  expect(nestedJoined.sort()).toEqual([false, false, true]);
  // ...and one is a sticky root rendered by the main view, which the main
  // socket itself did not join
  await expect(sticky(page)).toHaveClass(/phx-connected/);
  expect(
    await page.evaluate(() => "sticky-embedded" in window.mainLiveSocket.roots),
  ).toBe(false);
});

test("clicks are handled only by the owning socket", async ({ page }) => {
  await connectAll(page);

  await page.locator("#main-click").click();
  await syncLV(page);
  await expect(page.locator("#main-clicks")).toHaveText("1");
  await expect(nested(page).locator("[data-role=clicks]")).toHaveText("0");
  await expect(outside(page).locator("[data-role=clicks]")).toHaveText("0");

  await nested(page).locator("[data-role=click]").click();
  await syncLV(page);
  await expect(nested(page).locator("[data-role=clicks]")).toHaveText("1");
  await expect(outside(page).locator("[data-role=clicks]")).toHaveText("0");
  await expect(page.locator("#main-clicks")).toHaveText("1");

  await outside(page).locator("[data-role=click]").click();
  await syncLV(page);
  await expect(outside(page).locator("[data-role=clicks]")).toHaveText("1");
  await expect(nested(page).locator("[data-role=clicks]")).toHaveText("1");
  await expect(page.locator("#main-clicks")).toHaveText("1");
});

test("window bindings fire once per socket for a single event", async ({
  page,
}) => {
  await connectAll(page);

  await page.locator("body").press("Escape");
  await syncLV(page);
  await expect(page.locator("#main-keys")).toHaveText("1");
  await expect(nested(page).locator("[data-role=keys]")).toHaveText("1");
  await expect(outside(page).locator("[data-role=keys]")).toHaveText("1");

  await nested(page).locator("[data-role=click]").press("Escape");
  await syncLV(page);
  await expect(page.locator("#main-keys")).toHaveText("2");
  await expect(nested(page).locator("[data-role=keys]")).toHaveText("2");
  await expect(outside(page).locator("[data-role=keys]")).toHaveText("2");
});

test("form input is dispatched only to the owning socket", async ({ page }) => {
  await connectAll(page);

  await nested(page).locator("input[name=text]").fill("hello");
  await expect(nested(page).locator("[data-role=text]")).toHaveText("hello");
  await expect(outside(page).locator("[data-role=text]")).toBeEmpty();
  await expect(page.locator("#main-text")).toBeEmpty();

  await page.locator("#main-input").fill("world");
  await expect(page.locator("#main-text")).toHaveText("world");
  await expect(nested(page).locator("[data-role=text]")).toHaveText("hello");
  await expect(outside(page).locator("[data-role=text]")).toBeEmpty();
});

const destroyEmbedded = (page) =>
  page.evaluate(
    () => new Promise((resolve) => window.embeddedLiveSocket.destroy(resolve)),
  );

test("destroy leaves the socket's views and lets a fresh socket take them over", async ({
  page,
}) => {
  await connectAll(page);

  await nested(page).locator("[data-role=click]").click();
  await syncLV(page);
  await expect(nested(page).locator("[data-role=clicks]")).toHaveText("1");

  await destroyEmbedded(page);

  // both embedded roots left and ran their hooks' destroyed callbacks
  expect(await page.evaluate(() => window.probeDestroyed)).toBe(3);
  expect(
    await page.evaluate(() => Object.keys(window.embeddedLiveSocket.roots)),
  ).toEqual([]);
  expect(
    await page.evaluate(() => window.embeddedLiveSocket.isConnected()),
  ).toBe(false);
  expect(
    await page.evaluate(() => {
      try {
        window.embeddedLiveSocket.connect();
        return null;
      } catch (e) {
        return e.message;
      }
    }),
  ).toContain("destroyed");

  // the destroyed socket no longer handles events; the main one still does
  await nested(page).locator("[data-role=click]").click();
  await page.locator("#main-click").click();
  await syncLV(page);
  await expect(page.locator("#main-clicks")).toHaveText("1");
  await expect(nested(page).locator("[data-role=clicks]")).toHaveText("1");

  // a new socket joins the same roots (fresh server state) and drives them
  await page.evaluate(() => window.bootEmbedded());
  await expect(nested(page).locator("[data-role=clicks]")).toHaveText("0");
  await expect(outside(page).locator("[data-role=clicks]")).toHaveText("0");
  await nested(page).locator("[data-role=click]").click();
  await syncLV(page);
  await expect(nested(page).locator("[data-role=clicks]")).toHaveText("1");
  await expect(page.locator("#main-clicks")).toHaveText("1");
});

test("destroy releases the window listeners the socket installed", async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "listener inspection needs CDP");
  await connectAll(page);

  // the Phoenix Socket itself registers page lifecycle listeners in its
  // constructor and offers no way to remove them — those are not LiveView's
  // to release
  const phoenixSocketEvents = ["pagehide", "pageshow", "visibilitychange"];
  const cdp = await page.context().newCDPSession(page);
  const windowListeners = async () => {
    const { result } = await cdp.send("Runtime.evaluate", {
      expression: "window",
    });
    const { listeners } = await cdp.send("DOMDebugger.getEventListeners", {
      objectId: result.objectId,
    });
    return listeners.filter((l) => !phoenixSocketEvents.includes(l.type))
      .length;
  };

  const withBoth = await windowListeners();
  await destroyEmbedded(page);
  const mainOnly = await windowListeners();
  expect(mainOnly).toBeLessThan(withBoth);

  // re-creating the socket brings its listeners back, destroying it again
  // releases exactly those
  await page.evaluate(() => window.bootEmbedded());
  await expect(nested(page).locator("[data-role=clicks]")).toHaveText("0");
  expect(await windowListeners()).toBe(withBoth);
  await destroyEmbedded(page);
  expect(await windowListeners()).toBe(mainOnly);
});

// Live navigation is driven by the main socket; the sticky root belongs to
// the embedded one. LiveView carries stickies over to the new page and lets
// the next patch of the main view reconcile them with what the page renders.
const embeddedRoots = (page) =>
  page.evaluate(() => Object.keys(window.embeddedLiveSocket.roots).sort());

test("a sticky root of another socket survives live navigation", async ({
  page,
}) => {
  await connectAll(page);
  await sticky(page).locator("[data-role=click]").click();
  await syncLV(page);
  await expect(sticky(page).locator("[data-role=clicks]")).toHaveText("1");
  // tag the DOM node itself: attributes get morphed, expandos do not
  await page.evaluate(() => {
    document.getElementById("sticky-embedded").__carried = true;
  });

  await page.locator("#to-other-with-sticky").click();
  await expect(page).toHaveURL(/\/multi-socket\/other\?sticky=1$/);
  await syncLV(page);
  await page.locator("#other-click").click();
  await syncLV(page);
  await expect(page.locator("#other-clicks")).toHaveText("1");

  await expect(sticky(page)).toHaveCount(1);
  expect(
    await page.evaluate(
      () => document.getElementById("sticky-embedded").__carried,
    ),
  ).toBe(true);
  // same view, same server state, still driven by its own socket
  await expect(sticky(page).locator("[data-role=clicks]")).toHaveText("1");
  await sticky(page).locator("[data-role=click]").click();
  await syncLV(page);
  await expect(sticky(page).locator("[data-role=clicks]")).toHaveText("2");
  await expect(page.locator("#other-clicks")).toHaveText("1");
  expect(await embeddedRoots(page)).toContain("sticky-embedded");
});

test("a sticky root rendered by the next page is joined by its socket", async ({
  page,
}) => {
  await page.goto("/multi-socket/other");
  await syncLV(page);
  // main + nested; the outside root is only rendered on the main page
  await expect(page.locator("[data-phx-session].phx-connected")).toHaveCount(2);
  await expect(sticky(page)).toHaveCount(0);

  await page.locator("#to-main").click();
  await expect(page).toHaveURL(/\/multi-socket$/);
  await expect(sticky(page)).toHaveClass(/phx-connected/);
  await sticky(page).locator("[data-role=click]").click();
  await syncLV(page);
  await expect(sticky(page).locator("[data-role=clicks]")).toHaveText("1");
  expect(await embeddedRoots(page)).toContain("sticky-embedded");
  expect(
    await page.evaluate(() => "sticky-embedded" in window.mainLiveSocket.roots),
  ).toBe(false);
});

test("a sticky root dropped by the next page leaves its socket", async ({
  page,
}) => {
  await connectAll(page);

  await page.locator("#to-other-without-sticky").click();
  await expect(page).toHaveURL(/\/multi-socket\/other$/);
  await syncLV(page);
  // the carried-over root has no counterpart on this page; the next patch
  // of the main view drops it, and its own socket must be the one to leave
  await page.locator("#other-click").click();
  await syncLV(page);

  await expect(sticky(page)).toHaveCount(0);
  await expect.poll(() => embeddedRoots(page)).not.toContain("sticky-embedded");
  await expect.poll(() => page.evaluate(() => window.probeDestroyed)).toBe(1);
});
