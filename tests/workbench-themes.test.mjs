import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync(new URL("../app/workbench-themes.css", import.meta.url), "utf8");
function tokens(mode) {
  const body = css.match(new RegExp(`\\[data-color-mode="${mode}"\\][^{]*\\{([^}]+)\\}`))?.[1];
  assert.ok(body, `Missing ${mode} palette`);
  return Object.fromEntries([...body.matchAll(/(--[\w-]+):\s*(#[\da-f]+);/gi)].map(([, key, value]) => [key, value]));
}
function luminance(hex) {
  assert.match(hex, /^#[\da-f]{6}$/i);
  const rgb = hex.slice(1).match(/../g).map(value => parseInt(value, 16) / 255)
    .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
}
function contrast(first, second) {
  const values = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

for (const mode of ["light", "dark"]) {
  test(`${mode} palette preserves readable text, actions, selections and focus`, () => {
    const theme = tokens(mode);
    function check(foreground, background, minimum = 4.5) {
      const ratio = contrast(theme[foreground], theme[background]);
      assert.ok(ratio >= minimum, `${mode} ${foreground} on ${background}: ${ratio.toFixed(2)} < ${minimum}`);
    }
    for (const surface of ["--bgColor-default", "--bgColor-muted", "--bgColor-inset", "--overlay-bgColor", "--bgColor-accent-muted"]) {
      for (const foreground of ["--fgColor-default", "--fgColor-muted", "--fgColor-accent"]) check(foreground, surface);
      check("--focus-outlineColor", surface, 3);
    }
    for (const state of ["rest", "hover", "active"]) check("--button-primary-fgColor-rest", `--button-primary-bgColor-${state}`);
    check("--control-checked-fgColor-rest", "--bgColor-accent-emphasis");
    for (const surface of ["--bgColor-default", "--bgColor-muted"]) check("--control-borderColor-rest", surface, 3);
  });
}

test("approved palettes load after Primer without recoloring semantic review states or the PDF", () => {
  const light = tokens("light");
  const dark = tokens("dark");
  assert.equal(light["--button-primary-bgColor-rest"], "#245baf");
  assert.equal(dark["--button-primary-bgColor-rest"], "#80b4ff");
  assert.doesNotMatch(css, /--[\w-]*(?:success|danger|attention|diffBlob)[\w-]*\s*:/);
  assert.doesNotMatch(css, /\.pdf-page/);
  const layout = readFileSync(new URL("../app/layout.tsx", import.meta.url), "utf8");
  assert.ok(layout.indexOf('"./workbench-themes.css"') > layout.indexOf('"@primer/primitives/dist/css/functional/themes/dark.css"'));
  const shell = readFileSync(new URL("../app/primer-workbench.css", import.meta.url), "utf8");
  assert.match(shell, /\.primer-workbench \.pdf-page \{ background: white; color: black;/);
});
