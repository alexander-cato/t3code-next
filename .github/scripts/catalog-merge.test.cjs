const assert = require("node:assert/strict");
const test = require("node:test");
const { CATALOG, mergeCatalog, splitCatalog } = require("./catalog-merge.cjs");

const catalog = (...entries) => `{\n  ${entries.join(",\n  ")}\n}\n`;
const jsx = '"j": [\n    "Open ",\n    { "t": "code", "i": 1, "c": "t3.json" }\n  ]';

test("matches only app translation catalogs", () => {
  assert.ok(CATALOG.test("apps/web/src/i18n/translations/pt-BR.json"));
  assert.ok(CATALOG.test("apps/desktop/src/i18n/translations/en.json"));
  assert.ok(!CATALOG.test("apps/web/src/i18n/messages.json"));
  assert.ok(!CATALOG.test("packages/shared/src/i18n/translations/en.json"));
});

test("splits entries without reformatting them", () => {
  const text = catalog('"a": "A, with \\"quotes\\" and }"', jsx);
  assert.deepEqual([...splitCatalog(text).keys()], ["a", "j"]);
  assert.equal(splitCatalog(text).get("j").raw, jsx);
  assert.throws(() => splitCatalog('{"a": "A"}'));
  assert.throws(() => splitCatalog(catalog('"a": "A"', '"a": "B"')));
});

test("keeps both sides' new keys, upstream deletions, and one-sided edits", () => {
  const base = catalog('"a": "A"', '"b": "B"', '"c": "C"');
  const ours = catalog('"a": "A"', '"b": "Fork B"', '"c": "C"', '"fork": "Fork"');
  const theirs = catalog('"a": "A"', '"c": "C"', jsx);
  assert.equal(mergeCatalog(base, ours, theirs), undefined);
  const upstream = catalog('"a": "A"', '"b": "B"', jsx);
  assert.equal(
    mergeCatalog(base, ours, upstream),
    catalog('"a": "A"', '"b": "Fork B"', jsx, '"fork": "Fork"'),
  );
});

test("takes upstream's text for a value both sides agree on", () => {
  const base = catalog('"a": "A"');
  const ours = catalog('"a": "A"', '"j": ["Open ", { "t": "code", "i": 1, "c": "t3.json" }]');
  const theirs = catalog('"a": "A"', jsx);
  assert.equal(mergeCatalog(base, ours, theirs), theirs);
});

test("leaves keys that changed differently on both sides, and broken files, to a person", () => {
  const base = catalog('"a": "A"');
  assert.equal(mergeCatalog(base, catalog('"a": "Fork"'), catalog('"a": "Upstream"')), undefined);
  assert.equal(mergeCatalog(base, catalog('"a": "A"'), "{ not json"), undefined);
});
