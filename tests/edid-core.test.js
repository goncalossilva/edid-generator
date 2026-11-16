const assert = require("node:assert/strict");
const test = require("node:test");

globalThis.CTA_VIC = require("../data/cta-861-g-vic.json");
const { generateEdid, validateEdid } = require("../assets/js/edid-core.js");
const HD = { width: 1920, height: 1080, refresh: 60 };
const UHD = { width: 3840, height: 2160, refresh: 60 };
const options = { audio: true, hdr: false, deepColor: false, vrr: false, dsc: false, listedModesOnly: false };

function generate(defaultMode = HD, extra = [], settings = {}) {
  return generateEdid({ ...options, defaultMode, modes: [defaultMode, ...extra], ...settings });
}

// Decode the published binary fields independently of the importer and generator.
function readDtd(bytes, offset) {
  const dtd = bytes.subarray(offset, offset + 18);
  const width = dtd[2] | ((dtd[4] & 0xf0) << 4);
  const height = dtd[5] | ((dtd[7] & 0xf0) << 4);
  const hBlank = dtd[3] | ((dtd[4] & 0x0f) << 8);
  const vBlank = dtd[6] | ((dtd[7] & 0x0f) << 8);
  const clockKHz = (dtd[0] | (dtd[1] << 8)) * 10;
  return { width, height, clockKHz, refresh: clockKHz * 1000 / ((width + hBlank) * (height + vBlank)), flags: dtd[17] };
}

function extensions(bytes, tag) {
  const blocks = [];
  for (let offset = 128; offset < bytes.length; offset += 128) {
    if (bytes[offset] === tag) blocks.push(bytes.subarray(offset, offset + 128));
  }
  return blocks;
}

test("base and CTA DTDs encode separate sync with the intended CVT polarities", () => {
  for (const [mode, flags] of [[HD, 0x1a], [{ width: 1024, height: 768, refresh: 60 }, 0x1c]]) {
    const { bytes } = generate(mode);
    const base = readDtd(bytes, 54);
    assert.deepEqual([base.width, base.height, base.flags], [mode.width, mode.height, flags]);
    assert.ok(Math.abs(base.refresh - mode.refresh) < 0.5);
    const cta = extensions(bytes, 0x02)[0];
    assert.deepEqual(readDtd(cta, cta[2]), base);
    assert.deepEqual(validateEdid(bytes).issues, []);
  }
  const { bytes } = generate(HD, [{ width: 1024, height: 768, refresh: 60 }]);
  const cta = extensions(bytes, 0x02)[0];
  assert.equal(readDtd(cta, cta[2] + 18).flags, 0x1c);
});
