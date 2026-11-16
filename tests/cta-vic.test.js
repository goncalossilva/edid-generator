const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const canonical = require("../data/cta-861-g-vic.json");
const { renderCtaVic } = require("../scripts/generate-cta-vic.js");
const browserSource = fs.readFileSync(path.join(__dirname, "../assets/js/cta-861-g-vic.js"), "utf8");

test("the browser CTA VIC table matches the canonical JSON", () => {
  const sandbox = { window: {} };
  vm.runInNewContext(browserSource, sandbox, { filename: "assets/js/cta-861-g-vic.js" });
  // Normalize objects created in the VM to this realm before comparing prototypes.
  assert.deepEqual(JSON.parse(JSON.stringify(sandbox.window.CTA_VIC)), canonical);
});

test("the checked-in CTA VIC browser script is up to date", () => {
  assert.equal(browserSource, renderCtaVic(canonical), "Run node scripts/generate-cta-vic.js");
});

for (const [vic, name] of [[44, "1440x576i@100Hz 4:3"], [45, "1440x576i@100Hz 16:9"]]) {
  test(`VIC ${vic} is classified and named as interlaced`, () => {
    const entry = canonical.find((candidate) => candidate.vic === vic);
    assert.ok(entry, `Missing VIC ${vic}`);
    assert.equal(entry.interlaced, true);
    assert.equal(entry.name, name);
  });
}
