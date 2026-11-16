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

function displayIdModes(bytes) {
  const modes = [];
  for (const block of extensions(bytes, 0x70)) {
    for (let offset = 5; offset < 5 + block[2]; offset += 3 + block[offset + 2]) {
      if (block[offset] !== 0x03) continue;
      for (let entry = offset + 3; entry < offset + 3 + block[offset + 2]; entry += 20) {
        modes.push({ width: 1 + block[entry + 4] + (block[entry + 5] << 8), height: 1 + block[entry + 12] + (block[entry + 13] << 8) });
      }
    }
  }
  return modes;
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

test("dimensions that exceed DTD fields use DisplayID without truncation", () => {
  for (const mode of [{ width: 5120, height: 1440, refresh: 60 }, { width: 1920, height: 4320, refresh: 30 }]) {
    const result = generate(mode);
    const preferred = readDtd(result.bytes, 54);
    assert.deepEqual([preferred.width, preferred.height], [640, 480]);
    assert.deepEqual(displayIdModes(result.bytes), [{ width: mode.width, height: mode.height }]);
    assert.ok(result.warnings.some((warning) => warning.startsWith("Default mode can't fit")));
    assert.ok(!result.warnings.some((warning) => warning.includes("dropped")));
    assert.deepEqual(validateEdid(result.bytes).issues, []);

    const withFallback = generate(mode, [HD]);
    assert.deepEqual(withFallback.preferredMode, HD);
    assert.deepEqual(displayIdModes(withFallback.bytes), [{ width: mode.width, height: mode.height }]);
  }
});

test("DTD field and clock limits do not unnecessarily displace representable modes", () => {
  const fits = generate({ width: 4088, height: 1440, refresh: 60 });
  assert.equal(readDtd(fits.bytes, 54).width, 4088);
  assert.equal(fits.metadata.displayId, null);
  const tooWide = generate({ width: 4096, height: 1440, refresh: 60 });
  assert.deepEqual(displayIdModes(tooWide.bytes), [{ width: 4096, height: 1440 }]);
  const highClock = generate(HD, [{ width: 3000, height: 1920, refresh: 144 }]);
  assert.deepEqual(displayIdModes(highClock.bytes), [{ width: 3000, height: 1920 }]);
});
