import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("Follymarket publishes canonical metadata and discovery files", async () => {
  const [html, robots, llms, sitemap] = await Promise.all([
    source("web/index.html"),
    source("web/robots.txt"),
    source("web/llms.txt"),
    source("web/sitemap.xml"),
  ]);
  assert.match(html, /rel="canonical" href="https:\/\/follymarket\.tn07\.dev\/"/);
  assert.match(html, /property="og:title"/);
  assert.match(html, /name="twitter:card" content="summary"/);
  assert.match(robots, /User-agent: GPTBot\nDisallow: \//);
  assert.match(robots, /Sitemap: https:\/\/follymarket\.tn07\.dev\/sitemap\.xml/);
  assert.match(llms, /^# Follymarket$/m);
  assert.match(sitemap, /<loc>https:\/\/follymarket\.tn07\.dev\/<\/loc>/);
});
