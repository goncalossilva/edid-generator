#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const rootDir = path.resolve(__dirname, "..");
const outputDir = "/tmp/edid-fixtures";

fs.mkdirSync(outputDir, { recursive: true });
for (const entry of fs.readdirSync(outputDir)) {
  if (entry.endsWith(".bin")) {
    fs.unlinkSync(path.join(outputDir, entry));
  }
}
for (const entry of fs.readdirSync(outputDir)) {
  if (entry.endsWith(".expected-edid-decode.txt")) {
    fs.unlinkSync(path.join(outputDir, entry));
  }
}

globalThis.CTA_VIC = require(path.join(rootDir, "data", "cta-861-g-vic.json"));
const { generateEdid } = require(path.join(rootDir, "assets", "js", "edid-core.js"));

const cases = [
  {
    name: "basic-1080p",
    defaultMode: { width: 1920, height: 1080, refresh: 60 },
    modes: [
      { width: 1920, height: 1080, refresh: 60 },
      { width: 1280, height: 720, refresh: 60 },
    ],
    audio: true,
    hdr: false,
    deepColor: false,
    vrr: false,
    expectedWarnings: [],
    expectedDecodeWarnings: [],
  },
  {
    name: "no-audio-1080p",
    defaultMode: { width: 1920, height: 1080, refresh: 60 },
    modes: [
      { width: 1920, height: 1080, refresh: 60 },
      { width: 1280, height: 720, refresh: 60 },
    ],
    audio: false,
    hdr: false,
    deepColor: false,
    vrr: false,
    expectedWarnings: [],
    expectedDecodeWarnings: [],
  },
  {
    name: "hdr-4k60",
    defaultMode: { width: 3840, height: 2160, refresh: 60 },
    modes: [
      { width: 3840, height: 2160, refresh: 60 },
      { width: 1920, height: 1080, refresh: 60 },
    ],
    audio: true,
    hdr: true,
    deepColor: true,
    vrr: false,
    expectedWarnings: [],
    expectedDecodeWarnings: [],
  },
  {
    name: "10bit-4k60-no-hdr",
    defaultMode: { width: 3840, height: 2160, refresh: 60 },
    modes: [
      { width: 3840, height: 2160, refresh: 60 },
      { width: 1920, height: 1080, refresh: 60 },
    ],
    audio: true,
    hdr: false,
    deepColor: true,
    vrr: false,
    expectedWarnings: [],
    expectedDecodeWarnings: [],
  },
  {
    name: "vrr-1440p",
    defaultMode: { width: 2560, height: 1440, refresh: 120 },
    modes: [
      { width: 2560, height: 1440, refresh: 48 },
      { width: 2560, height: 1440, refresh: 120 },
    ],
    audio: true,
    hdr: false,
    deepColor: false,
    vrr: true,
    expectedWarnings: [],
    expectedDecodeWarnings: [],
  },
  {
    name: "hdr-vrr-1440p",
    defaultMode: { width: 2560, height: 1440, refresh: 120 },
    modes: [
      { width: 2560, height: 1440, refresh: 48 },
      { width: 2560, height: 1440, refresh: 120 },
    ],
    audio: true,
    hdr: true,
    deepColor: true,
    vrr: true,
    expectedWarnings: [],
    expectedDecodeWarnings: [],
  },
  {
    name: "4k120-vrr",
    defaultMode: { width: 3840, height: 2160, refresh: 60 },
    modes: [
      { width: 3840, height: 2160, refresh: 60 },
      { width: 3840, height: 2160, refresh: 48 },
      { width: 3840, height: 2160, refresh: 120 },
      { width: 1920, height: 1080, refresh: 120 },
    ],
    audio: true,
    hdr: false,
    deepColor: false,
    vrr: true,
    expectedWarnings: [],
    expectedDecodeWarnings: [],
  },
  {
    name: "displayid-highclock",
    defaultMode: { width: 3840, height: 2160, refresh: 60 },
    modes: [
      { width: 3840, height: 2160, refresh: 60 },
      { width: 3000, height: 1920, refresh: 144 },
      { width: 3456, height: 2234, refresh: 120 },
    ],
    audio: true,
    hdr: false,
    deepColor: true,
    vrr: false,
    expectedWarnings: [],
    expectedDecodeWarnings: [],
  },
  {
    name: "kitchen-sink",
    defaultMode: { width: 3840, height: 2160, refresh: 60 },
    modes: [
      { width: 3840, height: 2160, refresh: 60 },
      { width: 1920, height: 1080, refresh: 48 },
      { width: 3840, height: 2160, refresh: 120 },
      { width: 2560, height: 1440, refresh: 120 },
      { width: 1920, height: 1080, refresh: 120 },
      { width: 1920, height: 1080, refresh: 60 },
      { width: 1280, height: 720, refresh: 60 },
      { width: 1024, height: 768, refresh: 60 },
    ],
    audio: true,
    hdr: true,
    deepColor: true,
    vrr: true,
    expectedWarnings: [],
    expectedDecodeWarnings: [],
  },
  {
    name: "8k60-dsc",
    defaultMode: { width: 3840, height: 2160, refresh: 60 },
    modes: [
      { width: 3840, height: 2160, refresh: 60 },
      { width: 7680, height: 4320, refresh: 60 },
    ],
    audio: true,
    hdr: true,
    deepColor: true,
    dsc: true,
    vrr: false,
    expectedWarnings: [],
    expectedDecodeWarnings: [],
  },
  {
    name: "warn-vrr-clamp",
    defaultMode: { width: 2560, height: 1440, refresh: 144 },
    modes: [
      { width: 2560, height: 1440, refresh: 60 },
      { width: 2560, height: 1440, refresh: 144 },
    ],
    audio: true,
    hdr: false,
    deepColor: false,
    vrr: true,
    expectedWarnings: [
      "VRR range was clamped to supported limits (24-48 Hz min, 100-240 Hz max).",
    ],
    expectedDecodeWarnings: [],
  },
  {
    name: "warn-default-fallback",
    defaultMode: { width: 7680, height: 4320, refresh: 60 },
    modes: [
      { width: 7680, height: 4320, refresh: 60 },
      { width: 3840, height: 2160, refresh: 60 },
    ],
    audio: true,
    hdr: true,
    deepColor: true,
    dsc: true,
    vrr: false,
    expectedWarnings: [
      "Default mode can't fit base EDID timing limits. Lower resolution or refresh rate, or a fallback will be used.",
    ],
    expectedDecodeWarnings: [
      "Video Data Block: VIC 97 is the preferred timing, overriding the first detailed timings. Is this intended?",
    ],
  },
  {
    name: "warn-base-fallback-only",
    defaultMode: { width: 7680, height: 4320, refresh: 60 },
    modes: [
      { width: 7680, height: 4320, refresh: 60 },
    ],
    audio: true,
    hdr: true,
    deepColor: true,
    dsc: true,
    vrr: false,
    expectedWarnings: [
      "Default mode can't fit base EDID timing limits. Lower resolution or refresh rate, or a fallback will be used.",
      "No mode fits in the EDID base block. Falling back to 640x480@60.",
    ],
    expectedDecodeWarnings: [
      "Video Data Block: VIC 1 is the preferred timing, overriding the first detailed timings. Is this intended?",
    ],
  },
  {
    name: "warn-dsc-off-y420",
    defaultMode: { width: 3840, height: 2160, refresh: 60 },
    modes: [
      { width: 3840, height: 2160, refresh: 60 },
      { width: 7680, height: 4320, refresh: 60 },
    ],
    audio: true,
    hdr: false,
    deepColor: false,
    dsc: false,
    vrr: false,
    expectedWarnings: [
      "DSC off, assuming 4:2:0: DSC required by bandwidth but you disabled it.",
    ],
    expectedDecodeWarnings: [],
  },
];

const normalizeWarnings = (warnings) =>
  [...new Set(warnings)].map((warning) => warning.trim()).filter(Boolean).sort();

const assertWarnings = (name, actual, expected) => {
  const normalizedActual = normalizeWarnings(actual);
  const normalizedExpected = normalizeWarnings(expected);
  if (normalizedActual.length !== normalizedExpected.length) {
    console.error(`Warning mismatch for ${name}:`);
    console.error("Expected:");
    for (const warning of normalizedExpected) console.error(`- ${warning}`);
    console.error("Actual:");
    for (const warning of normalizedActual) console.error(`- ${warning}`);
    return false;
  }
  for (let i = 0; i < normalizedExpected.length; i += 1) {
    if (normalizedActual[i] !== normalizedExpected[i]) {
      console.error(`Warning mismatch for ${name}:`);
      console.error("Expected:");
      for (const warning of normalizedExpected) console.error(`- ${warning}`);
      console.error("Actual:");
      for (const warning of normalizedActual) console.error(`- ${warning}`);
      return false;
    }
  }
  return true;
};

for (const testCase of cases) {
  const result = generateEdid({ dsc: false, ...testCase });
  const outputPath = path.join(outputDir, `${testCase.name}.bin`);
  fs.writeFileSync(outputPath, Buffer.from(result.bytes));
  const expectedWarnings = testCase.expectedWarnings || [];
  if (!assertWarnings(testCase.name, result.warnings, expectedWarnings)) {
    process.exitCode = 1;
    break;
  }
  const expectedDecodeWarnings = testCase.expectedDecodeWarnings || [];
  const expectedPath = path.join(
    outputDir,
    `${testCase.name}.expected-edid-decode.txt`
  );
  fs.writeFileSync(expectedPath, expectedDecodeWarnings.join("\n"));
  console.log(`Wrote ${outputPath}`);
}
