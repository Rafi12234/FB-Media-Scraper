const test = require("node:test");
const assert = require("node:assert/strict");
const range = require("../image_range.js");

test("246–700 is inclusive and preserves original numbering", () => {
  const images = Array.from({ length: 1500 }, (_, n) => "image-" + (n + 1));
  const selected = range.select(images, 246, 700);
  assert.equal(selected.length, 455);
  assert.deepEqual(selected[0], { url: "image-246", index: 246 });
  assert.deepEqual(selected.at(-1), { url: "image-700", index: 700 });
});

test("open end selects the remainder and overrun truncates safely", () => {
  const images = Array.from({ length: 500 }, (_, n) => "image-" + (n + 1));
  assert.equal(range.select(images, 301, 0).length, 200);
  assert.equal(range.select(images, 246, 700).length, 255);
  assert.deepEqual(range.select(images, 600, 700), []);
});

test("invalid ranges are rejected instead of silently downloading the wrong images", () => {
  for (const [from, to] of [[0, 20], [246, 245], [-1, 10], [1.25, 700]]) {
    assert.throws(() => range.bounds(from, to));
  }
});
