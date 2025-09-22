// Probeert een externe product-URL uit de ad snapshot te halen.
export async function resolveProductLink(snapshotUrl, { timeout = 20000, headless = true } = {}) {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless });
  const ctx = await browser.newContext({
    viewport: { width: 1366, height: 900 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari",
    timezoneId: "Europe/Brussels",
    locale: "en-US"
  });
  const page = await ctx.newPage();
  try {
    await page.goto(snapshotUrl, { waitUntil: "domcontentloaded", timeout });
    // Soms laadt de preview traag → wacht even op DOM
    await page.waitForTimeout(1200);

    // 1) ‘a’ tags die naar buiten linken (geen facebook/instagram domein)
    const external = await page.$$eval('a[href^="http"]', as => {
      const bad = ["facebook.", "fbcdn.", "instagram.", "l.facebook.", "messenger."];
      const isGood = href => !bad.some(b => href.includes(b));
      const pick = as
        .map(a => a.getAttribute("href"))
        .filter(Boolean)
        .map(h => h.split("#")[0])
        .find(isGood);
      return pick || null;
    });
    if (external) return external;

    // 2) OpenGraph canonicals kunnen soms de landingspagina verraden
    const og = await page.$eval('meta[property="og:url"]', m => m.content).catch(() => null);
    if (og && !/facebook|instagram|messenger/.test(og)) return og;

    // 3) Als laatste redmiddel: alle URL-achtige strings in de tekst opsnorren
    const text = await page.evaluate(() => document.body.innerText || "");
    const m = text.match(/https?:\/\/[^\s)]+/g);
    if (m) {
      const cand = m.find(u => !/facebook|instagram|messenger/.test(u));
      if (cand) return cand;
    }
    return null;
  } finally {
    await browser.close();
  }
}
