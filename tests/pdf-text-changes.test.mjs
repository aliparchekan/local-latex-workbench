import assert from "node:assert/strict";
import test from "node:test";
import { diffPdfTextRuns } from "../app/lib/pdf-text-changes.mjs";

function run(text, item = 0, page = 1, x = 40, y = 100, hasEOL = true) {
  return { text, item, page, x, y, width: text.length * 5, height: 10, pageWidth: 600, pageHeight: 800, hasEOL };
}

test("a paragraph edit does not highlight unchanged text that flows to another column/page", async () => {
  const old = [run("This paragraph was short."), run("The following analysis is unchanged.", 1), run("Its conclusion is also unchanged.", 2)];
  const next = [run("This paragraph now contains additional details."), run("The following analysis", 1, 1, 330, 100), run("is unchanged.", 2, 1, 330, 115), run("Its conclusion is also unchanged.", 0, 2)];
  const diff = await diffPdfTextRuns(old, next);
  assert.deepEqual(diff.added.map(token => token.text), ["now", "contains", "additional", "details"]);
  assert.equal(diff.deleted[0].text, "was short");
  assert.ok(diff.added.every(token => token.spans.every(span => span.page === 1 && span.item === 0)));
});

test("reflow-only line breaks, column movement and page numbers produce no edits", async () => {
  const old = [run("The analysis has several useful conclusions."), run("1", 1, 1, 290, 760)];
  const next = [run("The analysis has", 0, 1, 330), run("several useful conclusions.", 0, 2), run("2", 1, 2, 290, 760)];
  assert.deepEqual(await diffPdfTextRuns(old, next), { added: [], deleted: [] });
});

test("hyphenation and ligatures are normalized with original PDF span locations preserved", async () => {
  const old = [run("The eﬃcient transfor-"), run("mation works.", 1, 1, 40, 115)];
  const next = [run("The efficient transformation works.")];
  assert.deepEqual(await diffPdfTextRuns(old, next), { added: [], deleted: [] });
  const change = await diffPdfTextRuns(next, [run("The eﬃcient transfor-"), run("mation fails.", 1, 1, 40, 115)]);
  assert.equal(change.added[0].text, "fails");
  assert.deepEqual(change.added[0].spans, [{ page: 1, item: 1, start: 7, end: 12 }]);
});

test("inline hyphens, punctuation, numbers and mathematical signs remain meaningful", async () => {
  const change = await diffPdfTextRuns([run("re-sign x = 42 + α.")], [run("resign x = 43 − α!")]);
  assert.deepEqual(change.added.map(token => token.text), ["resign", "43", "−", "!"]);
});

test("deletions attach to surviving current text, not to stale old-page coordinates", async () => {
  const change = await diffPdfTextRuns([run("Introduction. Remove this entire sentence. Conclusion.")], [run("Introduction. Conclusion.", 3, 2, 330, 250)]);
  assert.deepEqual(change.added, []);
  assert.equal(change.deleted[0].text, "Remove this entire sentence.");
  assert.deepEqual(change.deleted[0].anchor, { page: 2, item: 3, start: 14, end: 24 });
  assert.equal(change.deleted[0].replacement, false);
});

test("token matching survives different PDF item splitting and kerning", async () => {
  const old = [run("Hello world.")];
  const next = [run("Hel", 0, 1, 40, 100, false), run("lo", 1, 1, 55, 100, false), run("world.", 2, 1, 75)];
  assert.deepEqual(await diffPdfTextRuns(old, next), { added: [], deleted: [] });
});

test("blank/scanned PDFs explain that text comparison is unavailable", async () => {
  await assert.rejects(diffPdfTextRuns([], []), /No selectable PDF text/);
  const deleted = await diffPdfTextRuns([run("All removed.")], []);
  assert.equal(deleted.deleted[0].anchor, null);
});

test("repeated body lines near narrow margins must not be discarded as running headers", async () => {
  const old = [run("Repeated body sentence.", 0, 1, 40, 40), run("Another body line.", 1, 1, 40, 52), run("Repeated body sentence.", 0, 2, 40, 40), run("Another body line.", 1, 2, 40, 52)];
  const next = old.map(line => ({ ...line, y: line.y + 50 }));
  assert.deepEqual(await diffPdfTextRuns(old, next), { added: [], deleted: [] });
});

test("large revisions are partitioned without highlighting thousands of unchanged words", async () => {
  const old = [];
  const next = [];
  for (let paragraph = 0; paragraph < 25; paragraph++) {
    const stable = Array.from({ length: 200 }, (_, i) => `stable${paragraph}word${i}`).join(" ");
    old.push(run(stable, paragraph * 2), run(Array.from({ length: 500 }, (_, i) => `old${paragraph}word${i}`).join(" "), paragraph * 2 + 1));
    next.push(run(stable, paragraph * 2, 2), run(Array.from({ length: 500 }, (_, i) => `new${paragraph}word${i}`).join(" "), paragraph * 2 + 1, 2));
  }
  // 25,000 inserted/deleted tokens exceeded the old whole-document edit limit.
  const change = await diffPdfTextRuns(old, next);
  assert.equal(change.unresolved, undefined);
  assert.equal(change.added.length, 12_500);
  assert.ok(change.added.every(token => token.text.startsWith("new")));
  assert.ok(change.deleted.every(part => !part.text.includes("stable")));
  assert.ok(change.added.every(token => token.spans.every(span => span.page === 2)));
});

test("a long paragraph replacement keeps an identical repetitive body unhighlighted", async () => {
  const body = "These observations remain unchanged throughout the paper. ".repeat(1500);
  const old = [run("previous ".repeat(900)), run(body, 1)];
  const next = [run("revised ".repeat(1200)), run(body, 5, 12, 320)];
  const change = await diffPdfTextRuns(old, next);
  assert.equal(change.unresolved, undefined);
  assert.equal(change.added.length, 1200);
  assert.ok(change.added.every(token => token.text === "revised" && token.spans[0].item === 0));
  assert.equal(change.deleted.length, 1);
});

test("expanding a short sentence into a long explanation does not exhaust the edit budget", async () => {
  const stable = "The following analysis remains unchanged.";
  const old = [run("Our controller uses a fixed reference signal. This is the only paragraph we will revise."), run(stable, 1)];
  const next = [run("Our controller uses an adaptive reference signal. " + "The revised calibration procedure preserves the measurement assumptions. ".repeat(180)), run(stable, 3, 3)];
  const change = await diffPdfTextRuns(old, next);
  assert.equal(change.unresolved, undefined);
  assert.ok(change.added.length > 1500);
  assert.ok(change.added.every(token => token.spans.every(span => span.item === 0)));
});

test("an unresolved repetitive passage does not turn into a full-document highlight", async () => {
  const stable = "A distinctive unchanged sentence anchors the following passage.";
  const change = await diffPdfTextRuns(
    [run(`Oldword. ${stable} ${"alpha shared ".repeat(2000)}`)],
    [run(`Newword. ${stable} ${"beta shared ".repeat(2000)}`)],
  );
  assert.deepEqual(change.added.map(token => token.text), ["Newword"]);
  assert.equal(change.deleted[0].text, "Oldword");
  assert.equal(change.unresolved.length, 1);
  assert.equal(change.unresolved[0].page, 1);
  assert.ok(change.unresolved[0].newWords > 3000);
});

test("comparison cancellation is honored before work and at progress boundaries", async () => {
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(diffPdfTextRuns([run("before")], [run("after")], { signal: cancelled.signal }), { name: "AbortError" });
  const controller = new AbortController();
  await assert.rejects(diffPdfTextRuns([run("before")], [run("after")], {
    signal: controller.signal, onProgress: () => controller.abort(),
  }), { name: "AbortError" });
});
