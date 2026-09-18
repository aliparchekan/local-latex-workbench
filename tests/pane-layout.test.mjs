import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_PANES, fitPaneLayout, validPaneLayout } from "../app/lib/pane-layout.mjs";

test("pane preferences reject malformed data and bound stored proportions", () => {
  for (const invalid of [null, {}, 42, { source: "31", agent: 27 }, { source: NaN, agent: 27 }]) {
    assert.equal(validPaneLayout(invalid), null);
  }
  assert.deepEqual(validPaneLayout({ source: -1, agent: 100 }), { source: 15, agent: 65 });
  assert.deepEqual(validPaneLayout(DEFAULT_PANES), DEFAULT_PANES);
});

test("both panes leave a usable paper column at desktop and smaller widths", () => {
  for (const width of [390, 659, 761, 1024, 1440, 1920]) {
    for (const layout of [DEFAULT_PANES, { source: 65, agent: 65 }]) {
      const fitted = fitPaneLayout(layout, width);
      const paper = width - 10 - fitted.source - fitted.agent;
      assert.ok(paper >= Math.min(280, (width - 10) / 3) - 0.001);
      assert.ok(fitted.source >= fitted.minimum);
      assert.ok(fitted.agent >= fitted.minimum);
      assert.ok(fitted.source <= fitted.sourceMax + 0.001);
      assert.ok(fitted.agent <= fitted.agentMax + 0.001);
    }
  }
});

test("collapse releases space without mutating the saved proportions", () => {
  const saved = { ...DEFAULT_PANES };
  assert.equal(fitPaneLayout(saved, 1440, false).source, 0);
  assert.equal(fitPaneLayout(saved, 1440, true, false).agent, 0);
  assert.deepEqual(saved, DEFAULT_PANES);
  assert.equal(fitPaneLayout(saved, 1440).source, 1440 * saved.source / 100);
  assert.deepEqual(fitPaneLayout(saved, 0), fitPaneLayout(saved, 1440));
});
