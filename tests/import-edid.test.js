const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const CTA_VIC = require("../data/cta-861-g-vic.json");
globalThis.CTA_VIC = CTA_VIC;
const { parseEdid } = require("../assets/js/edid-import.js");
const { generateEdid } = require("../assets/js/edid-core.js");

const HD = { width: 1920, height: 1080, refresh: 60 };
const VGA = { width: 640, height: 480, refresh: 60 };
const UHD = { width: 3840, height: 2160, refresh: 60 };

// Fixtures below encode the published binary fields independently of EdidCore.
function checksum(block) {
  block[127] = 0;
  block[127] = (-block.reduce((sum, value) => sum + value, 0)) & 0xff;
  return block;
}

function descriptor(tag, data = []) {
  const bytes = new Uint8Array(18);
  bytes[3] = tag;
  bytes.set(data, 5);
  return bytes;
}

function standard(width, aspect, refresh = 60) {
  return [width / 8 - 31, (aspect << 6) | (refresh - 60)];
}

function dtd({ width = 1920, height = 1080, refresh = 60, hBlank = 280, vBlank = 45, interlaced = false } = {}) {
  const bytes = new Uint8Array(18);
  const clock = Math.round(((width + hBlank) * (height + vBlank) * refresh) / 10000);
  assert.ok(clock > 0 && clock <= 0xffff);
  bytes[0] = clock & 0xff;
  bytes[1] = clock >> 8;
  bytes[2] = width & 0xff;
  bytes[3] = hBlank & 0xff;
  bytes[4] = ((width >> 8) << 4) | (hBlank >> 8);
  bytes[5] = height & 0xff;
  bytes[6] = vBlank & 0xff;
  bytes[7] = ((height >> 8) << 4) | (vBlank >> 8);
  bytes[8] = 48;
  bytes[9] = 32;
  bytes[10] = 0x35;
  bytes[17] = 0x1e | (interlaced ? 0x80 : 0);
  return bytes;
}

function base({ timings = [dtd()], standards = [], established = [0, 0, 0], descriptors = [], revision = 3, flags = 0x02, input = 0x80 } = {}) {
  const bytes = new Uint8Array(128);
  bytes.set([0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00]);
  bytes[18] = 1;
  bytes[19] = revision;
  bytes[20] = input;
  bytes[24] = flags;
  bytes.set(established, 35);
  for (let index = 38; index < 54; index += 2) bytes.set([1, 1], index);
  standards.forEach((timing, index) => bytes.set(timing, 38 + index * 2));
  const entries = [...timings, ...descriptors];
  for (let index = 0; index < 4; index += 1) bytes.set(entries[index] || descriptor(0x10), 54 + index * 18);
  return checksum(bytes);
}

function dataBlock(tag, data) {
  assert.ok(data.length <= 31);
  return [(tag << 5) | data.length, ...data];
}

function cta({ blocks = [], timings = [], flags = 0x80, zeroOffset = false, revision = 3 } = {}) {
  const bytes = new Uint8Array(128);
  bytes.set([0x02, revision, 0, flags]);
  let index = 4;
  for (const block of blocks) {
    bytes.set(block, index);
    index += block.length;
  }
  bytes[2] = zeroOffset ? 0 : index;
  for (const timing of timings) {
    assert.ok(index + 18 <= 127);
    bytes.set(timing, index);
    index += 18;
  }
  return checksum(bytes);
}

function displayTiming({ width = 3000, height = 1920, refresh = 144, hBlank = 160, vBlank = 80, flags = 0x80, type7 = false } = {}) {
  const bytes = new Uint8Array(20);
  const clockUnit = type7 ? 1000 : 10000;
  const clock = Math.round(((width + hBlank) * (height + vBlank) * refresh) / clockUnit) - 1;
  bytes[0] = clock & 0xff;
  bytes[1] = (clock >> 8) & 0xff;
  bytes[2] = clock >> 16;
  bytes[3] = flags;
  const fields = [width, hBlank, 48, 32, height, vBlank, 3, 5];
  fields.forEach((value, index) => {
    bytes[4 + index * 2] = (value - 1) & 0xff;
    bytes[5 + index * 2] = (value - 1) >> 8;
  });
  return [...bytes];
}

function displayBlock(tag, data, revision = 0) {
  return [tag, revision, data.length, ...data];
}

function displayId(blocks, version = 0x13) {
  const bytes = new Uint8Array(128);
  const payload = blocks.flat();
  assert.ok(payload.length <= 121);
  bytes.set([0x70, version, payload.length, 3, 0]);
  bytes.set(payload, 5);
  fixDisplayChecksum(bytes);
  return bytes;
}

function fixDisplayChecksum(bytes) {
  const index = 5 + bytes[2];
  bytes[index] = (-bytes.subarray(1, index).reduce((sum, value) => sum + value, 0)) & 0xff;
  return checksum(bytes);
}

function edid(baseBlock = base(), ...extensions) {
  const bytes = new Uint8Array((extensions.length + 1) * 128);
  const first = baseBlock.slice();
  first[126] = extensions.length;
  bytes.set(checksum(first));
  extensions.forEach((block, index) => bytes.set(block, (index + 1) * 128));
  return bytes;
}

function hasMode(result, width, height, refresh) {
  return result.settings.modes.some((mode) => mode.width === width && mode.height === height && mode.refresh === refresh);
}

function hasWarning(result, pattern) {
  return result.warnings.some((warning) => pattern.test(warning));
}

test("exports the same dependency-free API in Node and a browser", () => {
  const sandbox = { Uint8Array, CTA_VIC };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../assets/js/edid-import.js"), "utf8"), sandbox);
  assert.equal(typeof sandbox.EdidImport.parseEdid, "function");
  assert.equal(JSON.stringify(sandbox.EdidImport.parseEdid(edid())), JSON.stringify(parseEdid(edid())));
});

test("rejects non-binary, incomplete, and oversized input", () => {
  for (const input of [null, [], new ArrayBuffer(128), "00 ff ff ff"]) {
    assert.throws(() => parseEdid(input), /binary EDID file/);
  }
  for (const length of [0, 127, 129, 255]) {
    assert.throws(() => parseEdid(new Uint8Array(length)), /128-byte blocks/);
  }
  assert.throws(() => parseEdid(new Uint8Array(257 * 128)), /256 blocks/);
});

test("validates the header, exact extension count, and every checksum", () => {
  const badHeader = base();
  badHeader[0] = 1;
  assert.throws(() => parseEdid(checksum(badHeader)), /header/);
  const missing = base();
  missing[126] = 1;
  assert.throws(() => parseEdid(checksum(missing)), /block count/);
  const trailing = edid(base(), cta());
  trailing[126] = 0;
  trailing.set(checksum(trailing.slice(0, 128)));
  assert.throws(() => parseEdid(trailing), /block count/);
  const baseChecksum = edid();
  baseChecksum[25] ^= 1;
  assert.throws(() => parseEdid(baseChecksum), /checksum.*block 0/);
  const extensionChecksum = edid(base(), cta());
  extensionChecksum[128 + 4] ^= 1;
  assert.throws(() => parseEdid(extensionChecksum), /checksum.*block 1/);
});

test("accepts at most 256 checksum-validated blocks and groups unknown extension warnings", () => {
  const extension = new Uint8Array(128);
  extension[0] = 0x99;
  checksum(extension);
  const result = parseEdid(edid(base(), ...Array(255).fill(extension)));
  assert.deepEqual(result.settings.defaultMode, HD);
  assert.deepEqual(result.warnings, ["Unsupported EDID extension (tag 0x99) was skipped."]);
});

test("recovers usable modes when extensions repeat the base block and warns that modes may be missing", () => {
  const first = base({ revision: 4, timings: [dtd({ width: 3440, height: 1440, hBlank: 160, vBlank: 60 })] });
  const video = cta({ blocks: [dataBlock(2, [118, 97])], flags: 0x81 });
  const expected = parseEdid(edid(first, video));
  for (const extensions of [[video, first], [first, video, first]]) {
    const bytes = edid(first, ...extensions);
    extensions.forEach((extension, index) => {
      // Repeat the final base block, including its extension count and checksum.
      if (extension === first) bytes.set(bytes.subarray(0, 128), (index + 1) * 128);
    });
    const before = bytes.slice();
    const result = parseEdid(bytes);
    assert.deepEqual(result.settings, expected.settings);
    assert.deepEqual(result.settings.defaultMode, { width: 3440, height: 1440, refresh: 60 });
    assert.ok(hasMode(result, 3840, 2160, 120));
    assert.equal(result.settings.modes.some((mode) => mode.width === 5120), false);
    assert.equal(result.warnings.length, 1);
    assert.ok(hasWarning(result, /extension repeats the base block.*Modes may be missing\. Re-export/));
    assert.deepEqual(bytes, before);
  }
});

test("does not mistake a different base-like block for a byte-for-byte duplicate", () => {
  const result = parseEdid(edid(base(), base()));
  assert.deepEqual(result.settings.modes, [HD]);
  assert.deepEqual(result.warnings, ["Unsupported EDID extension (tag 0x00) was skipped."]);
});

test("rejects unsupported EDID versions without rejecting sensible earlier 1.x files", () => {
  for (const [major, minor] of [[2, 0], [1, 5], [0, 3]]) {
    const bytes = base();
    bytes[18] = major;
    bytes[19] = minor;
    assert.throws(() => parseEdid(checksum(bytes)), /versions 1.0–1.4/);
  }
  for (const revision of [0, 1, 2, 3, 4]) assert.deepEqual(parseEdid(base({ revision })).settings.defaultMode, HD);
});

test("imports base preferred, standard, additional standard, and established modes with deduplication", () => {
  const additional = descriptor(0xfa, [...standard(1024, 1, 75), 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
  const bytes = base({
    timings: [dtd(), dtd({ width: 1280, height: 720 })],
    standards: [standard(1280, 3), standard(1280, 2, 75)],
    established: [0x21, 0x01, 0x80],
    descriptors: [additional],
  });
  const result = parseEdid(bytes);
  assert.deepEqual(result.settings.defaultMode, HD);
  assert.equal(result.settings.modes.length, 7);
  for (const mode of [[1920, 1080, 60], [1280, 720, 60], [1280, 1024, 75], [1024, 768, 75], [640, 480, 60], [800, 600, 60], [1152, 870, 75]]) {
    assert.ok(hasMode(result, ...mode), mode.join("x"));
  }
  assert.deepEqual(result.warnings, []);
});

test("base-only standard and established modes do not require a DTD", () => {
  const result = parseEdid(base({ timings: [], standards: [standard(1280, 0)], established: [0x20, 0x08, 0], flags: 0 }));
  assert.deepEqual(result.settings.defaultMode, { width: 1280, height: 800, refresh: 60 });
  assert.ok(hasMode(result, 1024, 768, 60));
  assert.ok(hasMode(result, 640, 480, 60));
  const old = parseEdid(base({ timings: [], standards: [standard(1280, 0)], revision: 2, flags: 0 }));
  assert.deepEqual(old.settings.defaultMode, { width: 1280, height: 1280, refresh: 60 });
});

test("EDID 1.4 always prefers its first detailed mode and only explicit 10-bit depth maps to deep color", () => {
  const preferred = parseEdid(edid(base({ revision: 4, flags: 0, input: 0xb0 }), cta({ blocks: [dataBlock(2, [0x84])], flags: 0x81 })));
  assert.deepEqual(preferred.settings.defaultMode, HD);
  assert.equal(preferred.settings.deepColor, true);
  for (const input of [0x30, 0x80, 0xa0, 0xc0]) {
    assert.equal(parseEdid(base({ revision: 4, input })).settings.deepColor, false);
  }
});

test("listed-modes-only reflects range formulas and GTF/continuous support, never infers VRR", () => {
  for (const [flags, formula, expected] of [[0, null, true], [1, null, false], [0, 0, false], [0, 1, true], [0, 2, false], [0, 4, false]]) {
    const descriptors = formula === null ? [] : [descriptor(0xfd, [24, 240, 15, 255, 60, formula])];
    const result = parseEdid(base({ flags, descriptors, revision: 4 }));
    assert.equal(result.settings.listedModesOnly, expected, `flags=${flags}, formula=${formula}`);
    assert.equal(result.settings.vrr, false);
  }
});

test("rounds fractional refresh, deduplicates rounded modes, and warns when skipping unsupported modes", () => {
  const result = parseEdid(edid(base({
    timings: [dtd({ refresh: 59.94 }), dtd(), dtd({ width: 640, height: 480, refresh: 300 }), dtd({ interlaced: true })],
    established: [0, 0x10, 0],
  }), cta({ blocks: [dataBlock(2, [5, 6, 254, 254, 255])] })));
  assert.deepEqual(result.settings.modes, [HD]);
  for (const warning of [/Fractional refresh/, /Interlaced/, /outside the supported/, /CTA video mode.*VIC 254/, /CTA video mode.*VIC 255/]) assert.ok(hasWarning(result, warning));
  assert.equal(result.warnings.filter((warning) => /Unrecognized CTA/.test(warning)).length, 2);
  assert.equal(result.warnings.filter((warning) => /Interlaced/.test(warning)).length, 1);
  const tiny = parseEdid(base({ timings: [dtd(), dtd({ width: 256 }), dtd({ height: 128 }), dtd({ refresh: 10 })] }));
  assert.deepEqual(tiny.settings.modes, [HD]);
  assert.ok(hasWarning(tiny, /outside the supported/));
});

test("requires at least one usable progressive mode and rejects malformed detailed timings", () => {
  for (const bytes of [base({ timings: [], flags: 0 }), base({ timings: [dtd({ interlaced: true })] }), base({ timings: [dtd({ width: 128 })] })]) {
    assert.throws(() => parseEdid(bytes), /No usable progressive modes/);
  }
  const broken = dtd();
  broken[2] = 0;
  broken[4] &= 0x0f;
  assert.throws(() => parseEdid(base({ timings: [broken] })), /detailed timing is invalid/);
});

test("imports CTA native and extended VICs without confusing high VICs with native bits", () => {
  const result = parseEdid(edid(base({ timings: [], flags: 0 }), cta({ blocks: [dataBlock(2, [0x81, 65, 193, 194, 219])] })));
  assert.deepEqual(result.settings.defaultMode, VGA);
  for (const mode of [[1280, 720, 24], [5120, 2160, 120], [7680, 4320, 24], [4096, 2160, 120]]) assert.ok(hasMode(result, ...mode));
  assert.equal(result.settings.modes.length, 5);
});

test("respects base, CTA first SVD, native, DisplayID, and explicit video-preference precedence", () => {
  const video = [dataBlock(2, [4, 16])];
  assert.deepEqual(parseEdid(edid(base(), cta({ blocks: video, flags: 0x81 }))).settings.defaultMode, HD);
  assert.deepEqual(parseEdid(edid(base(), cta({ blocks: video }))).settings.defaultMode, { width: 1280, height: 720, refresh: 60 });
  const preferred = displayId([displayBlock(3, displayTiming())]);
  const withDisplay = parseEdid(edid(base(), cta({ blocks: video }), preferred));
  assert.deepEqual(withDisplay.settings.defaultMode, { width: 1280, height: 720, refresh: 60 });
  assert.deepEqual(parseEdid(edid(base(), preferred)).settings.defaultMode, HD);
  assert.deepEqual(parseEdid(edid(base({ flags: 0 }), preferred)).settings.defaultMode, { width: 3000, height: 1920, refresh: 144 });
  const explicit = cta({ blocks: [...video, dataBlock(7, [0x0d, 97, 4])] });
  assert.deepEqual(parseEdid(edid(base(), explicit, preferred)).settings.defaultMode, UHD);
  const reference = cta({ blocks: [dataBlock(7, [0x0d, 130])], timings: [dtd({ width: 1280, height: 720 })] });
  assert.deepEqual(parseEdid(edid(base(), reference)).settings.defaultMode, { width: 1280, height: 720, refresh: 60 });
  const unsupportedPreference = parseEdid(edid(base(), cta({ blocks: [dataBlock(7, [0x0d, 145, 144])] })));
  assert.deepEqual(unsupportedPreference.settings.defaultMode, HD);
  assert.ok(hasWarning(unsupportedPreference, /preference references/));
});

test("valid CTA zero timing offsets and basic audio work without a data block collection", () => {
  const result = parseEdid(edid(base(), cta({ zeroOffset: true, flags: 0xc0 })));
  assert.deepEqual(result.settings.defaultMode, HD);
  assert.equal(result.settings.audio, true);
  assert.deepEqual(result.warnings, []);
});

test("rejects malformed CTA offsets, bounds, padding, and incomplete detailed timings", () => {
  for (const offset of [1, 3, 128, 255]) {
    const extension = cta();
    extension[2] = offset;
    assert.throws(() => parseEdid(edid(base(), checksum(extension))), /timing offset/);
  }
  const zeroOffset = cta({ zeroOffset: true });
  zeroOffset[4] = 0x41;
  assert.throws(() => parseEdid(edid(base(), checksum(zeroOffset))), /nonzero padding/);
  const overrun = cta({ blocks: [dataBlock(2, [16])] });
  overrun[4] = (2 << 5) | 3;
  assert.throws(() => parseEdid(edid(base(), checksum(overrun))), /past the timing offset/);
  const padding = cta({ blocks: [dataBlock(2, [16])] });
  padding[4] = 0;
  assert.throws(() => parseEdid(edid(base(), checksum(padding))), /data-block padding/);
  const incomplete = cta();
  incomplete[126] = 1;
  assert.throws(() => parseEdid(edid(base(), checksum(incomplete))), /incomplete detailed timings/);
  const zeroRevision = cta({ revision: 0 });
  assert.throws(() => parseEdid(edid(base(), zeroRevision)), /invalid header/);
});

test("rejects structurally truncated known CTA data blocks", () => {
  for (const block of [dataBlock(1, [9, 7]), dataBlock(2, []), dataBlock(3, [3, 12]), dataBlock(4, [1]), dataBlock(7, []), dataBlock(7, [6, 4]), dataBlock(7, [0x79, 0, 0])]) {
    assert.throws(() => parseEdid(edid(base(), cta({ blocks: [block] }))), /invalid length|empty|truncated/);
  }
});

test("requires complete OUIs before diagnosing CTA extended vendor blocks", () => {
  for (const tag of [0x01, 0x11]) {
    for (const oui of [[], [0x46], [0x46, 0xd0]]) {
      const block = dataBlock(7, [tag, ...oui]);
      assert.throws(() => parseEdid(edid(base(), cta({ blocks: [block] }))), /extended vendor data block is truncated/);
    }
  }
});

test("identifies and deduplicates unsupported CTA vendor capabilities without inferring features", () => {
  const blocks = [
    dataBlock(3, [0x56, 0x34, 0x12]),
    dataBlock(3, [0xef, 0xcd, 0xab]),
    dataBlock(3, [0x1a, 0, 0, 1, 0, 48, 165, 0]),
    dataBlock(7, [0x01, 0x46, 0xd0, 0x00, 0x81, 0, 0, 0, 0]),
    dataBlock(7, [0x01, 0x56, 0x34, 0x12]),
    dataBlock(7, [0x11, 0x46, 0xd0, 0x00]),
  ];
  const result = parseEdid(edid(base(), cta({ blocks }), cta({ blocks })));
  assert.deepEqual(result.settings.modes, [HD]);
  for (const feature of ["audio", "hdr", "deepColor", "vrr", "dsc"]) assert.equal(result.settings[feature], false, feature);
  assert.equal(result.warnings.length, 6);
  for (const warning of [
    /vendor-specific.*tag 0x03.*OUI 0x123456/,
    /vendor-specific.*tag 0x03.*OUI 0xabcdef/,
    /AMD FreeSync.*tag 0x03.*OUI 0x00001a.*were not imported\. This block does not establish HDMI VRR/,
    /vendor-specific video.*Dolby.*OUI 0x00d046.*extended tag 0x01/,
    /vendor-specific video.*OUI 0x123456.*extended tag 0x01/,
    /vendor-specific audio.*Dolby.*OUI 0x00d046.*extended tag 0x11/,
  ]) assert.ok(hasWarning(result, warning), warning.toString());
});

test("identifies unknown extension and CTA block tags while grouping repeated identifiers", () => {
  const extensions = [0x99, 0x98].map((tag) => {
    const bytes = new Uint8Array(128);
    bytes[0] = tag;
    return checksum(bytes);
  });
  const blocks = [dataBlock(0, [1]), dataBlock(5, [1]), dataBlock(7, [0x07, 1]), dataBlock(7, [0x7f, 1])];
  const result = parseEdid(edid(base(), ...extensions, ...extensions, cta({ blocks }), cta({ blocks })));
  assert.deepEqual(result.settings.modes, [HD]);
  assert.equal(result.warnings.length, 6);
  for (const warning of [
    /EDID extension.*tag 0x99/,
    /EDID extension.*tag 0x98/,
    /CTA data block.*tag 0x00/,
    /CTA data block.*tag 0x05/,
    /CTA extended data block.*tag 0x07/,
    /CTA extended data block.*tag 0x7f/,
  ]) assert.ok(hasWarning(result, warning), warning.toString());
});

test("identifies unsupported CTA extension revisions and groups repeats", () => {
  const result = parseEdid(edid(base(), ...[4, 5, 4].map((revision) => cta({ revision }))));
  assert.deepEqual(result.settings.modes, [HD]);
  assert.equal(result.warnings.length, 2);
  assert.ok(hasWarning(result, /unsupported CTA extension revision 4/));
  assert.ok(hasWarning(result, /unsupported CTA extension revision 5/));
});

test("extracts only supported LPCM, PQ, RGB 10-bit, HDMI VRR, and DSC feature bits", () => {
  const blocks = [
    dataBlock(1, [0x09, 0x07, 0x07]),
    dataBlock(7, [0x06, 0x04, 0x01]),
    dataBlock(3, [0x03, 0x0c, 0x00, 0x10, 0x00, 0x10, 60]),
    dataBlock(3, [0xd8, 0x5d, 0xc4, 1, 120, 0x80, 0x60, 0, 48, 144, 0x81, 0x63, 0]),
  ];
  const result = parseEdid(edid(base(), cta({ blocks, flags: 0x81 })));
  const { defaultMode, modes, ...features } = result.settings;
  assert.deepEqual(features, { audio: true, hdr: true, deepColor: true, vrr: true, dsc: true, listedModesOnly: true });
  assert.deepEqual(result.warnings, []);
  const unsupported = parseEdid(edid(base(), cta({ blocks: [
    dataBlock(1, [0x15, 0x07, 0x00]),
    dataBlock(7, [0x06, 0x08, 0x01]),
    dataBlock(3, [0x03, 0x0c, 0x00, 0, 0, 0x20]),
    dataBlock(3, [0xd8, 0x5d, 0xc4, 1, 120, 0x80, 0x64, 0, 0, 144, 0x01, 0x63, 0]),
  ], flags: 0x81 })));
  for (const feature of ["audio", "hdr", "deepColor", "vrr", "dsc"]) assert.equal(unsupported.settings[feature], false, feature);
  for (const warning of [/stereo LPCM/, /other than PQ/, /Color depths/, /invalid HDMI VRR/, /chroma restrictions/]) assert.ok(hasWarning(unsupported, warning));
});

test("requires both PQ and Static Metadata Type 1 in a CTA block to import HDR10", () => {
  for (const [eotfs, metadata, hdr, warning] of [
    [0x00, 0x00, false, false],
    [0x00, 0x01, false, false],
    [0x02, 0x01, false, false],
    [0x04, 0x00, false, true],
    [0x04, 0x02, false, true],
    [0x04, 0x01, true, false],
    [0x06, 0x03, true, false],
  ]) {
    const result = parseEdid(edid(base(), cta({ blocks: [dataBlock(7, [0x06, eotfs, metadata])] })));
    const label = `EOTFs=${eotfs}, metadata=${metadata}`;
    assert.equal(result.settings.hdr, hdr, label);
    assert.equal(hasWarning(result, /PQ.*Static Metadata Type 1.*HDR10/), warning, label);
    assert.equal(result.warnings.length, warning ? 1 : 0, label);
  }
});

test("unions complete HDR10 advertisements without combining incomplete blocks and groups PQ warnings", () => {
  const pqOnly = dataBlock(7, [0x06, 0x04, 0x00]);
  const type1Only = dataBlock(7, [0x06, 0x00, 0x01]);
  const hdr10 = dataBlock(7, [0x06, 0x04, 0x01]);
  for (const [blocks, hdr] of [
    [[pqOnly, type1Only, pqOnly], false],
    [[hdr10, pqOnly, type1Only, pqOnly], true],
    [[pqOnly, type1Only, pqOnly, hdr10], true],
  ]) {
    for (const extensions of [[cta({ blocks })], blocks.map((block) => cta({ blocks: [block] }))]) {
      const result = parseEdid(edid(base(), ...extensions));
      assert.equal(result.settings.hdr, hdr);
      assert.equal(result.warnings.length, 1);
      assert.ok(hasWarning(result, /PQ.*Static Metadata Type 1.*HDR10/));
    }
  }
});

test("does not invent basic LPCM support from unsupported LPCM sample formats", () => {
  const result = parseEdid(edid(base(), cta({ blocks: [dataBlock(1, [0x09, 0x04, 0x04])] })));
  assert.equal(result.settings.audio, false);
  assert.ok(hasWarning(result, /stereo LPCM/));
});

test("decodes the HDMI Forum sink capability block and full 10-bit VRR maximum", () => {
  const result = parseEdid(edid(base(), cta({ blocks: [dataBlock(7, [0x79, 0, 0, 1, 120, 0x80, 0x60, 0, 0x70, 44, 0x80, 0x63, 0])] })));
  assert.equal(result.settings.vrr, true); // 48–300 Hz, not 48–44 Hz.
  assert.equal(result.settings.dsc, true);
  const unknown = parseEdid(edid(base(), cta({ blocks: [dataBlock(3, [0xd8, 0x5d, 0xc4, 2, 120, 0x80, 0x60, 0, 48, 144, 0x80, 0x63, 0])] })));
  assert.equal(unknown.settings.vrr, false);
  assert.equal(unknown.settings.dsc, false);
  assert.ok(hasWarning(unknown, /unsupported HDMI Forum capability version 2/));
});

test("rejects partial HDMI Forum fields and bounds-checks optional HDMI latency/video sections", () => {
  for (const length of [3, 6, 8, 9]) {
    const data = [1, 120, 0x80, 0x60, 0, 48, 144, 0x80, 0x63, 0].slice(0, length);
    assert.throws(() => parseEdid(edid(base(), cta({ blocks: [dataBlock(3, [0xd8, 0x5d, 0xc4, ...data])] }))), /truncated/);
  }
  for (const data of [
    [3, 12, 0, 0, 0],
    [3, 12, 0, 0, 0, 0, 60, 0x80],
    [3, 12, 0, 0, 0, 0, 60, 0x20, 0],
    [3, 12, 0, 0, 0, 0, 60, 0x20, 0, 0x40, 1],
  ].slice(1)) {
    assert.throws(() => parseEdid(edid(base(), cta({ blocks: [dataBlock(3, data)] }))), /truncated|invalid lengths/);
  }
  const hdmiVic = parseEdid(edid(base(), cta({ blocks: [dataBlock(3, [3, 12, 0, 0, 0, 0x10, 60, 0xa0, 0, 0, 0, 0x20, 1])] })));
  assert.ok(hasMode(hdmiVic, 3840, 2160, 30));
  assert.equal(hdmiVic.settings.deepColor, true);
});

test("unknown extensions, vendors, and significant unsupported capability blocks are warned about, not inferred", () => {
  const unknown = new Uint8Array(128);
  unknown[0] = 0x99;
  checksum(unknown);
  const blockMap = new Uint8Array(128);
  blockMap[0] = 0xf0;
  checksum(blockMap);
  const result = parseEdid(edid(base(), blockMap, unknown, cta({ blocks: [
    dataBlock(3, [0x1a, 0, 0, 1, 0, 48, 144, 0]), // An AMD range is not HDMI VRR.
    dataBlock(7, [7, 0, 0]),
    dataBlock(7, [0x0e, 97]),
    dataBlock(7, [0x0f, 1]),
  ] })));
  assert.equal(result.settings.vrr, false);
  assert.equal(result.settings.hdr, false);
  assert.equal(hasMode(result, 3840, 2160, 60), false);
  for (const warning of [/EDID extension.*tag 0x99/, /AMD FreeSync.*OUI 0x00001a/, /CTA extended data block.*tag 0x07/, /chroma restrictions/]) assert.ok(hasWarning(result, warning));
  assert.deepEqual(parseEdid(edid(base(), blockMap)).warnings, []);
});

test("imports independent DisplayID 1.3 Type I timings, preference, and explicit 10-bit interface support", () => {
  const extension = displayId([
    displayBlock(0, [0, 0, 0, 1, 0, 1, 0, 0, 0, 1, 24, 0]),
    displayBlock(1, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x99]),
    displayBlock(0x0f, [0x71, 0x21, 0x06, 0x06, 0x03, 0, 0, 0, 0, 0]),
    displayBlock(3, [...displayTiming(), ...displayTiming({ width: 3456, height: 2234, refresh: 120, flags: 0 })]),
  ]);
  const result = parseEdid(edid(base({ flags: 0 }), extension));
  assert.deepEqual(result.settings.defaultMode, { width: 3000, height: 1920, refresh: 144 });
  assert.ok(hasMode(result, 3456, 2234, 120));
  assert.equal(result.settings.deepColor, true);
  assert.equal(result.settings.modes.length, 3);
  const interfaceOnly = parseEdid(edid(base(), displayId([displayBlock(0x0f, [0x71, 0x21, 4, 0, 0, 0, 0, 0, 0, 0])])));
  assert.equal(interfaceOnly.settings.deepColor, true);
});

test("imports explicit 5120x2160 timings from valid DisplayID 1.3 and 2.0 extensions", () => {
  const mode = { width: 5120, height: 2160, refresh: 165 };
  for (const [version, tag, type7] of [[0x13, 0x03, false], [0x20, 0x22, true]]) {
    const timing = displayTiming({ ...mode, type7 });
    const result = parseEdid(edid(base({ flags: 0 }), displayId([displayBlock(tag, timing)], version)));
    assert.deepEqual(result.settings.defaultMode, mode);
    assert.deepEqual(result.settings.modes, [mode, HD]);
    assert.deepEqual(result.warnings, []);
  }
});

test("DisplayID 2.0 Type VII uses 1-kHz clocks and revision-specific preferred/4:2:0 flags", () => {
  const extension = displayId([displayBlock(0x22, displayTiming({ type7: true }), 0)], 0x20);
  assert.deepEqual(parseEdid(edid(base({ flags: 0 }), extension)).settings.defaultMode, { width: 3000, height: 1920, refresh: 144 });
  const variable = displayId([displayBlock(0x22, [...displayTiming({ type7: true, flags: 0 }), 0], 0x19)], 0x20);
  const result = parseEdid(edid(base(), variable));
  assert.ok(hasMode(result, 3000, 1920, 144));
  assert.equal(result.settings.dsc, false); // DSC pass-through does not advertise HDMI sink DSC support.
  const y420 = parseEdid(edid(base(), displayId([displayBlock(0x22, displayTiming({ type7: true }), 2)], 0x20)));
  assert.deepEqual(y420.settings.modes, [HD]);
  assert.ok(hasWarning(y420, /chroma restrictions/));
});

test("skips unsupported DisplayID timings, revisions, and versions without inventing features", () => {
  const result = parseEdid(edid(base(), displayId([
    displayBlock(3, displayTiming({ flags: 0x90 })),
    displayBlock(3, displayTiming(), 2),
    displayBlock(4, Array(11).fill(0)),
  ])));
  assert.deepEqual(result.settings.modes, [HD]);
  for (const warning of [/Interlaced/, /timing revision.*tag 0x03.*revision 0x02/, /DisplayID data block.*tag 0x04.*revision 0x00/]) assert.ok(hasWarning(result, warning));
  const unknown = parseEdid(edid(base(), displayId([displayBlock(0x22, displayTiming({ type7: true }))], 0x21)));
  assert.deepEqual(unknown.settings.modes, [HD]);
  assert.ok(hasWarning(unknown, /unsupported DisplayID version 0x21/));
});

test("validates DisplayID payload checksums separately from EDID checksums, bounds, and timing lengths", () => {
  const oversized = displayId([]);
  oversized[2] = 122;
  assert.throws(() => parseEdid(edid(base(), checksum(oversized))), /payload is too long/);
  const badChecksum = displayId([displayBlock(3, displayTiming())]);
  badChecksum[8] ^= 1;
  assert.throws(() => parseEdid(edid(base(), checksum(badChecksum))), /payload checksum/);
  const crossing = displayId([displayBlock(3, displayTiming())]);
  crossing[7] = 21;
  fixDisplayChecksum(crossing);
  assert.throws(() => parseEdid(edid(base(), crossing)), /past its payload/);
  for (const extension of [
    displayId([displayBlock(3, Array(19).fill(0))]),
    displayId([displayBlock(0x22, Array(21).fill(0))], 0x20),
    displayId([displayBlock(1, Array(11).fill(0))]),
    displayId([displayBlock(0x0f, Array(9).fill(0))]),
  ]) assert.throws(() => parseEdid(edid(base(), extension)), /invalid length/);
  const padding = displayId([]);
  padding[100] = 1;
  assert.throws(() => parseEdid(edid(base(), checksum(padding))), /nonzero padding/);
  const shortHeader = displayId([[3, 0]]);
  assert.throws(() => parseEdid(edid(base(), shortHeader)), /past its payload/);
});

test("accepts Uint8Array subviews without mutating the caller's binary", () => {
  const original = edid(base(), cta({ blocks: [dataBlock(2, [16])] }));
  const buffer = new Uint8Array(original.length + 16).fill(0xa5);
  buffer.set(original, 7);
  const before = buffer.slice();
  assert.deepEqual(parseEdid(buffer.subarray(7, 7 + original.length)).settings.defaultMode, HD);
  assert.deepEqual(buffer, before);
});

test("regenerates imported HDR settings without adding unsupported HDR10 capabilities", () => {
  for (const [eotfs, metadata, hdr] of [[0x04, 0x00, false], [0x04, 0x02, false], [0x00, 0x01, false], [0x04, 0x01, true]]) {
    const imported = parseEdid(edid(base(), cta({ blocks: [dataBlock(7, [0x06, eotfs, metadata])] })));
    const generated = generateEdid(imported.settings);
    assert.equal(generated.features.hdr, hdr);
    const regenerated = parseEdid(generated.bytes);
    assert.equal(regenerated.settings.hdr, hdr);
    assert.equal(hasWarning(regenerated, /PQ.*Static Metadata Type 1/), false);
  }
});

test("imports generated settings as a starting point, including DisplayID overflow and DSC", () => {
  const cases = [
    { defaultMode: HD, modes: [HD, { width: 1280, height: 720, refresh: 60 }], audio: true },
    { defaultMode: UHD, modes: [UHD, HD], hdr: true, deepColor: true, listedModesOnly: true },
    { defaultMode: { width: 2560, height: 1440, refresh: 120 }, modes: [{ width: 2560, height: 1440, refresh: 120 }, { width: 2560, height: 1440, refresh: 48 }], vrr: true },
    { defaultMode: UHD, modes: [UHD, { width: 3000, height: 1920, refresh: 144 }, { width: 3456, height: 2234, refresh: 120 }], deepColor: true },
    { defaultMode: { width: 7680, height: 4320, refresh: 60 }, modes: [{ width: 7680, height: 4320, refresh: 60 }, UHD], audio: true, hdr: true, deepColor: true, dsc: true },
  ];
  for (const settings of cases) {
    const generated = generateEdid({ audio: false, hdr: false, deepColor: false, vrr: false, dsc: false, listedModesOnly: false, ...settings });
    const imported = parseEdid(generated.bytes);
    assert.deepEqual(imported.settings.defaultMode, generated.preferredMode);
    for (const mode of settings.modes) assert.ok(hasMode(imported, mode.width, mode.height, mode.refresh), JSON.stringify(mode));
    for (const feature of ["audio", "hdr", "deepColor", "vrr", "dsc", "listedModesOnly"]) {
      assert.equal(imported.settings[feature], generated.features[feature], feature);
    }
    assert.ok(hasMode(imported, 640, 480, 60)); // The generator always advertises its compatibility fallback.
  }
});
