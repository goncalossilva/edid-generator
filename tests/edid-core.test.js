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

function ctaData(bytes) {
  const blocks = [];
  for (const cta of extensions(bytes, 0x02)) {
    for (let offset = 4; offset < cta[2];) {
      const length = cta[offset] & 0x1f;
      blocks.push({ tag: cta[offset] >> 5, data: [...cta.subarray(offset + 1, offset + 1 + length)] });
      offset += length + 1;
    }
  }
  return blocks;
}

function forumBlock(bytes) {
  return ctaData(bytes).find(({ tag, data }) => tag === 3 && data[0] === 0xd8 && data[1] === 0x5d && data[2] === 0xc4)?.data;
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

test("4K60 advertises HDMI 2.0 TMDS bandwidth and SCDC without requiring FRL", () => {
  const result = generate(UHD);
  const forum = forumBlock(result.bytes);
  assert.ok(forum, "4K60 needs an HDMI Forum VSDB");
  assert.ok(forum[4] * 5 >= 594 && forum[4] * 5 <= 600, "TMDS must cover VIC 97's 594 MHz clock");
  assert.ok(forum[5] & 0x80, "SCDC must be present above 340 MHz");
  assert.equal(forum[6] >> 4, 0, "HDMI 2.0 TMDS does not require FRL");
  assert.equal(result.metadata.hdmiVersion, "HDMI 2.0");
  assert.equal(result.metadata.frlAdvertised, false);
  assert.equal(forumBlock(generate(HD).bytes), undefined, "1080p60 still needs only the HDMI VSDB");
  assert.ok(forumBlock(generate(HD, [{ ...UHD, refresh: 120 }]).bytes)[6] >> 4, "Higher bandwidth retains FRL signaling");
});

test("link and range budgets cover emitted CVT timings as well as their CTA VICs", () => {
  for (const mode of [{ width: 720, height: 480, refresh: 240 }, { width: 720, height: 576, refresh: 200 }]) {
    const { bytes, metadata } = generate(mode);
    const dtd = readDtd(bytes, 54);
    const hdmi = ctaData(bytes).find(({ tag, data }) => tag === 3 && data[0] === 3 && data[1] === 0x0c && data[2] === 0).data;
    assert.ok(hdmi[6] * 5000 >= dtd.clockKHz, "TMDS must cover the emitted CVT DTD, not just the VIC");
    assert.equal(bytes[75], 0xfd);
    assert.ok(bytes[81] * 10000 >= dtd.clockKHz, "The range descriptor must cover the emitted clock");
    assert.ok(metadata.maxPixelClockKHz >= dtd.clockKHz);
  }
  const onlyVic = generate({ width: 640, height: 480, refresh: 60 }, [{ width: 720, height: 480, refresh: 240 }]);
  assert.equal(onlyVic.metadata.maxPixelClockKHz, 108000, "Do not budget a CVT timing that is never emitted");
  const small = generate({ width: 320, height: 200, refresh: 120 });
  const hdmi = ctaData(small.bytes).find(({ tag, data }) => tag === 3 && data[0] === 3 && data[1] === 0x0c && data[2] === 0).data;
  assert.ok(hdmi[6] * 5000 >= 25175, "Always budget the advertised VIC 1 compatibility mode");
});
