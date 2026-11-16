const assert = require("node:assert/strict");
const test = require("node:test");

globalThis.CTA_VIC = require("../data/cta-861-g-vic.json");
const { generateEdid } = require("../assets/js/edid-core.js");
const { parseEdid } = require("../assets/js/edid-import.js");

const options = { audio: false, hdr: false, deepColor: false, vrr: false, dsc: false, listedModesOnly: false };
const HD = { width: 1920, height: 1080, refresh: 60 };
const modeAt = (index) => ({ width: 640 + 8 * (index % 300), height: 480 + 8 * Math.floor(index / 300), refresh: 60 });
const modeKey = (mode) => `${mode.width}x${mode.height}@${mode.refresh}`;

function checksum(block) {
  block[127] = 0;
  block[127] = (-block.reduce((sum, byte) => sum + byte, 0)) & 0xff;
}

function assertBinaryBounds(bytes) {
  assert.ok(bytes.length <= 32768, `EDID exceeds 32 KiB: ${bytes.length} bytes`);
  assert.equal(bytes.length % 128, 0);
  assert.equal(bytes[126], bytes.length / 128 - 1, "Extension count must exactly match the output length");
  for (let offset = 0; offset < bytes.length; offset += 128) {
    assert.equal(bytes.subarray(offset, offset + 128).reduce((sum, byte) => sum + byte, 0) & 0xff, 0,
      `Invalid checksum in block ${offset / 128}`);
  }
}

function assertMappedOutput(bytes) {
  assertBinaryBounds(bytes);
  assert.ok(bytes[126] <= 127, "All extensions must fit the existing single block map");
  const map = bytes.subarray(128, 256);
  assert.equal(map[0], 0xf0);
  for (let index = 1; index <= 126; index += 1) {
    const expected = index < bytes[126] ? bytes[(index + 1) * 128] : 0;
    assert.equal(map[index], expected, `Incorrect block-map tag at entry ${index}`);
  }
}

function assertSafeRegeneration(settings) {
  const result = generateEdid(settings);
  assertMappedOutput(result.bytes);
  const imported = parseEdid(result.bytes);
  assert.deepEqual(imported.settings.defaultMode, settings.defaultMode);
  assert.ok(imported.settings.modes.length < settings.modes.length, "Excess modes must be omitted");
  const lastMode = settings.modes.at(-1);
  assert.ok(!imported.settings.modes.some((mode) => modeKey(mode) === modeKey(lastMode)));
  const warning = result.warnings.find((message) => /DisplayID.*dropped:/i.test(message));
  assert.ok(warning, "Capacity exhaustion must produce a dropped-mode warning");
  assert.ok(warning.includes(`${lastMode.width}x${lastMode.height}`), "The warning must identify omitted modes");
}

// Independently encode six progressive DTDs per CTA block. The source stays within
// the input's 256-block limit, but repacking its modes into DisplayID needs more.
function denseImport() {
  const bytes = new Uint8Array(32768);
  const initial = generateEdid({ ...options, defaultMode: HD, modes: [HD] });
  bytes.set(initial.bytes.subarray(0, 128));
  bytes[126] = 255;
  checksum(bytes.subarray(0, 128));
  for (let extension = 1; extension <= 255; extension += 1) {
    const block = bytes.subarray(extension * 128, (extension + 1) * 128);
    block.set([0x02, 0x03, 0x04, 0x81]);
    for (let timing = 0; timing < 6; timing += 1) {
      const { width, height, refresh } = modeAt((extension - 1) * 6 + timing);
      const hBlank = 160;
      const vBlank = 45;
      const clock = Math.round(((width + hBlank) * (height + vBlank) * refresh) / 10000);
      const dtd = new Uint8Array(18);
      dtd.set([
        clock & 0xff, clock >> 8,
        width & 0xff, hBlank & 0xff, ((width >> 8) << 4) | (hBlank >> 8),
        height & 0xff, vBlank & 0xff, ((height >> 8) << 4) | (vBlank >> 8),
        48, 32, 0x35,
      ]);
      dtd[17] = 0x1e;
      block.set(dtd, 4 + timing * 18);
    }
    checksum(block);
  }
  return bytes;
}

test("a mode-dense 32-KiB import regenerates within EDID capacity and warns about dropped modes", () => {
  const source = denseImport();
  assertBinaryBounds(source);
  const imported = parseEdid(source);
  assert.equal(imported.settings.modes.length, 1531);
  assert.deepEqual(imported.settings.defaultMode, HD);
  assertSafeRegeneration(imported.settings);
});

test("generating 1600 unique custom modes cannot overflow the block-map capacity", () => {
  const modes = [HD, ...Array.from({ length: 1600 }, (_, index) => modeAt(index))];
  assert.equal(new Set(modes.map(modeKey)).size, 1601);
  assertSafeRegeneration({ ...options, defaultMode: HD, modes });
});

test("CTA detailed timing overflow moves to DisplayID without silently omitting modes", () => {
  const modes = [HD, ...Array.from({ length: 7 }, (_, index) => modeAt(index + 1))];
  const result = generateEdid({ ...options, defaultMode: HD, modes });
  assertMappedOutput(result.bytes);
  const imported = parseEdid(result.bytes);
  const resolutions = new Set(imported.settings.modes.map((mode) => `${mode.width}x${mode.height}`));
  for (const mode of modes) {
    assert.ok(resolutions.has(`${mode.width}x${mode.height}`), `Resolution missing: ${mode.width}x${mode.height}`);
  }
  assert.ok(!result.warnings.some((message) => /dropped|ran out of space/i.test(message)));
});

test("hundreds of modes below capacity are retained without dropped-mode warnings", () => {
  // Keep custom timings above the base DTD clock limit to isolate DisplayID capacity.
  const modes = [HD, ...Array.from({ length: 600 }, (_, index) => ({
    width: 5000 + 8 * (index % 200), height: 3000 + 8 * Math.floor(index / 200), refresh: 60,
  }))];
  const result = generateEdid({ ...options, defaultMode: HD, modes });
  assertMappedOutput(result.bytes);
  const imported = parseEdid(result.bytes);
  assert.deepEqual(imported.settings.defaultMode, HD);
  const retained = new Set(imported.settings.modes.map(modeKey));
  for (const mode of modes) assert.ok(retained.has(modeKey(mode)), `Mode missing: ${modeKey(mode)}`);
  assert.ok(!result.warnings.some((message) => /dropped|ran out of space/i.test(message)));
});
