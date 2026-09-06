import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";

import { app } from "../src/app.js";

const APPROVED_SOLID_COLORS = new Set([
  "#FFFFFF",
  "#E6E6E6",
  "#D6D6D6",
  "#B3B3B3",
  "#555555",
  "#333333",
  "#111111",
  "#0B1020",
  "#12192B",
  "#19223A",
  "#212C49",
  "#34415F",
  "#5C6D96",
  "#7C3AED",
  "#6D28D9",
  "#A78BFA",
  "#89CFF0",
  "#5EEAD4",
  "#123C3A",
  "#2C7A70",
  "#A7F3E8",
  "#3A1821",
  "#7F3043",
  "#FFB4C0",
  "#FF7A90",
]);

function colorTokens(styles) {
  return new Map(
    [...styles.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})\s*;/giu)].map(
      ([, name, value]) => [name, value.toUpperCase()]
    )
  );
}

function relativeLuminance(hex) {
  const channels = hex
    .slice(1)
    .match(/.{2}/gu)
    .map((channel) => Number.parseInt(channel, 16) / 255)
    .map((channel) =>
      channel <= 0.04045
        ? channel / 12.92
        : ((channel + 0.055) / 1.055) ** 2.4
    );
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(first, second) {
  const lighter = Math.max(relativeLuminance(first), relativeLuminance(second));
  const darker = Math.min(relativeLuminance(first), relativeLuminance(second));
  return (lighter + 0.05) / (darker + 0.05);
}

async function withApp(callback) {
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  try {
    await callback(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
    await once(server, "close");
  }
}

test("first-party ForgePass UI is isolated by strict browser headers", async () => {
  await withApp(async (base) => {
    const response = await fetch(`${base}/forgepass/`);
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") || "", /text\/html/u);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    assert.equal(response.headers.get("cross-origin-opener-policy"), "same-origin");
    assert.equal(response.headers.get("cross-origin-resource-policy"), "same-origin");

    const csp = response.headers.get("content-security-policy") || "";
    assert.match(csp, /default-src 'self'/u);
    assert.match(csp, /frame-ancestors 'none'/u);
    assert.match(csp, /object-src 'none'/u);
    assert.match(csp, /script-src 'self'/u);
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/u);

    const permissions = response.headers.get("permissions-policy") || "";
    assert.match(permissions, /publickey-credentials-create=\(self\)/u);
    assert.match(permissions, /publickey-credentials-get=\(self\)/u);
    assert.match(html, /ForgePass authentication, end to end\./u);
    assert.match(html, /allow it so SendForge can\s+confirm the ForgePass device identifier/u);
    assert.match(html, /<meta name="color-scheme" content="dark" \/>/u);
    assert.match(html, /<meta name="theme-color" content="#0B1020" \/>/u);
    assert.doesNotMatch(html, /https?:\/\//u);
  });
});

test("ForgePass UI keeps its session tab-scoped and has no remote assets", async () => {
  await withApp(async (base) => {
    const [scriptResponse, styleResponse] = await Promise.all([
      fetch(`${base}/forgepass/app.js`),
      fetch(`${base}/forgepass/styles.css`),
    ]);
    const [script, styles] = await Promise.all([
      scriptResponse.text(),
      styleResponse.text(),
    ]);

    assert.equal(scriptResponse.status, 200);
    assert.equal(styleResponse.status, 200);
    assert.match(script, /window\.sessionStorage/u);
    assert.doesNotMatch(script, /localStorage/u);
    assert.doesNotMatch(script, /https?:\/\//u);
    assert.match(script, /did not recognize this authenticator as ForgePass/u);
    assert.match(script, /registration could not be verified/u);
    assert.match(script, /could not verify that sign-in/u);
    assert.doesNotMatch(styles, /https?:\/\//u);
    assert.doesNotMatch(styles, /url\s*\(/u);
    assert.doesNotMatch(
      styles,
      /(?:repeating-)?(?:linear|radial|conic)-gradient\s*\(/u
    );
    assert.doesNotMatch(styles, /\b(?:backdrop-)?filter\s*:/u);
    assert.doesNotMatch(styles, /\bopacity\s*:/u);
    assert.match(styles, /:root\s*\{[^}]*color-scheme:\s*dark;/su);
    assert.match(styles, /--white:\s*#FFFFFF/u);

    const colors = new Set(
      [...styles.matchAll(/#[0-9a-f]{6}\b/giu)].map(([value]) =>
        value.toUpperCase()
      )
    );
    assert.deepEqual(
      [...colors].sort(),
      [...APPROVED_SOLID_COLORS].sort(),
      "the stylesheet must use only the approved solid-color palette"
    );

    for (const [, red, green, blue] of styles.matchAll(
      /rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,/gu
    )) {
      assert.equal(red, green, "transparent shadows must stay neutral");
      assert.equal(green, blue, "transparent shadows must stay neutral");
    }

    const tokens = colorTokens(styles);
    for (const [name, value] of tokens) {
      if (!name.startsWith("gray-")) continue;
      const [red, green, blue] = value
        .slice(1)
        .match(/.{2}/gu)
        .map((channel) => Number.parseInt(channel, 16));
      assert.equal(red, green, `${name} must be a channel-equal neutral gray`);
      assert.equal(green, blue, `${name} must be a channel-equal neutral gray`);
    }

    const requiredContrastPairs = [
      ["white", "purple"],
      ["gray-500", "surface-raised"],
      ["baby-blue", "surface-raised"],
      ["teal", "surface"],
      ["success-text", "success-surface"],
      ["error-text", "error-surface"],
      ["gray-950", "baby-blue"],
    ];
    for (const [foreground, background] of requiredContrastPairs) {
      assert.ok(
        contrastRatio(tokens.get(foreground), tokens.get(background)) >= 4.5,
        `${foreground} on ${background} must meet 4.5:1 contrast`
      );
    }

    assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/u);
    assert.match(styles, /\.step-card:hover,[^}]*transform:\s*none;/su);

    const passkeyRule = [
      ...styles.matchAll(/(?:^|\n)\.passkey-button\s*\{([^}]*)\}/gu),
    ].at(-1)?.[1];
    assert.ok(passkeyRule, "the ForgePass CTA must have a dedicated style rule");
    assert.doesNotMatch(
      passkeyRule,
      /background\s+\d+ms/u,
      "the ForgePass CTA fill must switch atomically to preserve contrast"
    );
  });
});
