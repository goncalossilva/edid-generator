(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(root);
  } else {
    root.EdidCore = factory(root);
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";

  const CTA_VIC = root.CTA_VIC || [];
  const MAX_DTD_PIXEL_CLOCK_KHZ = 655350;
  const MAX_DISPLAYID_DATA_BYTES = 121;
  const DISPLAYID_VERSION = 0x13;
  const DEFAULT_VENDOR = "GSS";
  const DEFAULT_NAME = "edid.build";

  function formatMode(mode) {
    return `${mode.width}x${mode.height} @ ${mode.refresh}Hz`;
  }

  function modeKey(mode) {
    return `${mode.width}x${mode.height}@${mode.refresh}`;
  }

  function deriveVrrRange(modes) {
    const refreshes = modes.map((mode) => mode.refresh);
    const min = Math.min(...refreshes);
    const max = Math.max(...refreshes);
    return { min, max };
  }

  function gcd(a, b) {
    let x = Math.abs(a);
    let y = Math.abs(b);
    while (y) {
      const t = y;
      y = x % y;
      x = t;
    }
    return x;
  }

  function approximateAspect(width, height) {
    const known = [
      { label: "4:3", ratio: 4 / 3 },
      { label: "5:4", ratio: 5 / 4 },
      { label: "16:10", ratio: 16 / 10 },
      { label: "16:9", ratio: 16 / 9 },
      { label: "21:9", ratio: 21 / 9 },
      { label: "64:27", ratio: 64 / 27 },
    ];
    const ratio = width / height;
    let best = null;
    for (const entry of known) {
      const delta = Math.abs(ratio - entry.ratio);
      if (delta < 0.02 && (!best || delta < best.delta)) {
        best = { label: entry.label, delta };
      }
    }
    if (best) return best.label;

    const div = gcd(width, height);
    return `${width / div}:${height / div}`;
  }

  function findCtaVic(mode) {
    const aspect = approximateAspect(mode.width, mode.height);
    const candidates = CTA_VIC.filter(
      (entry) =>
        entry.width === mode.width &&
        entry.height === mode.height &&
        entry.refresh === mode.refresh &&
        !entry.interlaced
    );
    if (!candidates.length) return null;

    const withAspect = candidates.find((entry) => entry.aspect === aspect);
    return withAspect || candidates[0];
  }

  function shouldUseReducedBlanking(mode) {
    return mode.width >= 1920 || mode.height >= 1080 || mode.refresh > 60;
  }

  function generateCvtTiming(width, height, refresh, reduced) {
    const CVT_H_GRANULARITY = 8;
    const CVT_MIN_V_PORCH = 3;
    const CVT_MIN_V_BPORCH = 6;
    const CVT_CLOCK_STEP = 250;

    let vFieldRate = refresh;
    let interlace = 0;

    const hDisplayRnd = width - (width % CVT_H_GRANULARITY);
    const vDisplayRnd = height;

    const vSync = (() => {
      if (!(height % 3) && (height * 4) / 3 === width) return 4;
      if (!(height % 9) && (height * 16) / 9 === width) return 5;
      if (!(height % 10) && (height * 16) / 10 === width) return 6;
      if (!(height % 4) && (height * 5) / 4 === width) return 7;
      if (!(height % 9) && (height * 15) / 9 === width) return 7;
      return 10;
    })();

    let hPeriod = 0;
    let hTotal = 0;
    let vTotal = 0;
    let hSyncStart = 0;
    let hSyncEnd = 0;
    let vSyncStart = 0;
    let vSyncEnd = 0;

    if (!reduced) {
      const CVT_MIN_VSYNC_BP = 550.0;
      const CVT_HSYNC_PERCENTAGE = 8;
      const CVT_M_FACTOR = 600;
      const CVT_C_FACTOR = 40;
      const CVT_K_FACTOR = 128;
      const CVT_J_FACTOR = 20;

      const CVT_M_PRIME = (CVT_M_FACTOR * CVT_K_FACTOR) / 256;
      const CVT_C_PRIME =
        ((CVT_C_FACTOR - CVT_J_FACTOR) * CVT_K_FACTOR) / 256 + CVT_J_FACTOR;

      hPeriod =
        (1000000.0 / vFieldRate - CVT_MIN_VSYNC_BP) /
        (vDisplayRnd + CVT_MIN_V_PORCH + interlace);

      let vSyncAndBackPorch = Math.floor(CVT_MIN_VSYNC_BP / hPeriod) + 1;
      if (vSyncAndBackPorch < vSync + CVT_MIN_V_PORCH) {
        vSyncAndBackPorch = vSync + CVT_MIN_V_PORCH;
      }

      vTotal = vDisplayRnd + vSyncAndBackPorch + interlace + CVT_MIN_V_PORCH;

      let hBlankPercent = CVT_C_PRIME - (CVT_M_PRIME * hPeriod) / 1000.0;
      if (hBlankPercent < 20) hBlankPercent = 20;

      let hBlank =
        (hDisplayRnd * hBlankPercent) / (100.0 - hBlankPercent);
      hBlank -= hBlank % (2 * CVT_H_GRANULARITY);

      hTotal = hDisplayRnd + hBlank;

      hSyncEnd = hDisplayRnd + hBlank / 2;
      hSyncStart = hSyncEnd - (hTotal * CVT_HSYNC_PERCENTAGE) / 100;
      hSyncStart += CVT_H_GRANULARITY - (hSyncStart % CVT_H_GRANULARITY);

      vSyncStart = vDisplayRnd + CVT_MIN_V_PORCH;
      vSyncEnd = vSyncStart + vSync;
    } else {
      const CVT_RB_MIN_VBLANK = 460.0;
      const CVT_RB_H_SYNC = 32.0;
      const CVT_RB_H_BLANK = 160.0;
      const CVT_RB_VFPORCH = 3;

      hPeriod =
        (1000000.0 / vFieldRate - CVT_RB_MIN_VBLANK) / vDisplayRnd;

      let vBlankIntervalLines = Math.floor(CVT_RB_MIN_VBLANK / hPeriod) + 1;
      if (vBlankIntervalLines < CVT_RB_VFPORCH + vSync + CVT_MIN_V_BPORCH) {
        vBlankIntervalLines = CVT_RB_VFPORCH + vSync + CVT_MIN_V_BPORCH;
      }

      vTotal = vDisplayRnd + interlace + vBlankIntervalLines;
      hTotal = hDisplayRnd + CVT_RB_H_BLANK;

      hSyncEnd = hDisplayRnd + CVT_RB_H_BLANK / 2;
      hSyncStart = hSyncEnd - CVT_RB_H_SYNC;

      vSyncStart = vDisplayRnd + CVT_RB_VFPORCH;
      vSyncEnd = vSyncStart + vSync;
    }

    let dotClock = (hTotal * 1000.0) / hPeriod;
    dotClock -= dotClock % CVT_CLOCK_STEP;

    const hSync = dotClock / hTotal;
    const vRefresh = (1000.0 * dotClock) / (hTotal * vTotal);

    const hSyncPositive = reduced;
    const vSyncPositive = !reduced;

    return {
      hDisplay: hDisplayRnd,
      vDisplay: vDisplayRnd,
      hSyncStart: Math.round(hSyncStart),
      hSyncEnd: Math.round(hSyncEnd),
      hTotal: Math.round(hTotal),
      vSyncStart: Math.round(vSyncStart),
      vSyncEnd: Math.round(vSyncEnd),
      vTotal: Math.round(vTotal),
      dotClockKHz: Math.round(dotClock),
      hSyncKHz: hSync,
      vRefreshHz: vRefresh,
      hSyncPositive,
      vSyncPositive,
    };
  }

  function timingToDtd(timing) {
    const hActive = timing.hDisplay;
    const hBlank = timing.hTotal - timing.hDisplay;
    const vActive = timing.vDisplay;
    const vBlank = timing.vTotal - timing.vDisplay;
    const hFrontPorch = timing.hSyncStart - timing.hDisplay;
    const hSyncWidth = timing.hSyncEnd - timing.hSyncStart;
    const vFrontPorch = timing.vSyncStart - timing.vDisplay;
    const vSyncWidth = timing.vSyncEnd - timing.vSyncStart;

    const pixelClock = Math.round(timing.dotClockKHz / 10);

    const dtd = new Uint8Array(18);
    dtd[0] = pixelClock & 0xff;
    dtd[1] = (pixelClock >> 8) & 0xff;
    dtd[2] = hActive & 0xff;
    dtd[3] = hBlank & 0xff;
    dtd[4] = ((hActive >> 8) << 4) | ((hBlank >> 8) & 0x0f);
    dtd[5] = vActive & 0xff;
    dtd[6] = vBlank & 0xff;
    dtd[7] = ((vActive >> 8) << 4) | ((vBlank >> 8) & 0x0f);
    dtd[8] = hFrontPorch & 0xff;
    dtd[9] = hSyncWidth & 0xff;
    dtd[10] = ((vFrontPorch & 0x0f) << 4) | (vSyncWidth & 0x0f);
    dtd[11] =
      (((hFrontPorch >> 8) & 0x03) << 6) |
      (((hSyncWidth >> 8) & 0x03) << 4) |
      (((vFrontPorch >> 8) & 0x03) << 2) |
      ((vSyncWidth >> 8) & 0x03);

    dtd[12] = 0x00;
    dtd[13] = 0x00;
    dtd[14] = 0x00;
    dtd[15] = 0x00;
    dtd[16] = 0x00;

    let flags = 0x10;
    if (timing.vSyncPositive) flags |= 0x08;
    if (timing.hSyncPositive) flags |= 0x04;
    dtd[17] = flags;

    return dtd;
  }

  function descriptorBlock(type, payload) {
    const block = new Uint8Array(18);
    block[0] = 0x00;
    block[1] = 0x00;
    block[2] = 0x00;
    block[3] = type;
    block[4] = 0x00;
    block.set(payload.slice(0, 13), 5);
    return block;
  }

  function nameDescriptor(name) {
    const text = name.slice(0, 12);
    const bytes = new Uint8Array(13).fill(0x20);
    for (let i = 0; i < text.length; i += 1) {
      bytes[i] = text.charCodeAt(i);
    }
    bytes[Math.min(text.length, 12)] = 0x0a;
    return descriptorBlock(0xfc, bytes);
  }

  function rangeDescriptor(minV, maxV, minH, maxH, maxClockMHz) {
    const payload = new Uint8Array(13);
    payload[0] = minV;
    payload[1] = maxV;
    payload[2] = minH;
    payload[3] = maxH;
    payload[4] = Math.min(255, Math.ceil(maxClockMHz / 10));
    payload[5] = 0x00;
    payload[6] = 0x0a;
    payload[7] = 0x20;
    payload[8] = 0x20;
    payload[9] = 0x20;
    payload[10] = 0x20;
    payload[11] = 0x20;
    payload[12] = 0x20;
    return descriptorBlock(0xfd, payload);
  }

  function dummyDescriptor() {
    return descriptorBlock(0x10, new Uint8Array(13));
  }

  function encodeManufacturerId(code) {
    const safe = code.toUpperCase().padEnd(3, "X").slice(0, 3);
    const chars = [...safe].map((c) => Math.min(26, Math.max(1, c.charCodeAt(0) - 64)));
    const packed = (chars[0] << 10) | (chars[1] << 5) | chars[2];
    return [packed >> 8, packed & 0xff];
  }

  function encodeChromaticity() {
    const primaries = [
      { x: 0.64, y: 0.33 },
      { x: 0.30, y: 0.60 },
      { x: 0.15, y: 0.06 },
      { x: 0.3127, y: 0.329 },
    ];
    const values = primaries.flatMap((p) => {
      const x = Math.round(p.x * 1024);
      const y = Math.round(p.y * 1024);
      return [x, y];
    });

    const low1 =
      ((values[0] & 0x03) << 6) |
      ((values[1] & 0x03) << 4) |
      ((values[2] & 0x03) << 2) |
      (values[3] & 0x03);
    const low2 =
      ((values[4] & 0x03) << 6) |
      ((values[5] & 0x03) << 4) |
      ((values[6] & 0x03) << 2) |
      (values[7] & 0x03);

    const high = values.map((v) => (v >> 2) & 0xff);

    return [low1, low2, ...high];
  }

  function checksum(bytes) {
    const sum = bytes.reduce((acc, b) => acc + b, 0);
    return (256 - (sum % 256)) % 256;
  }

  function dataBlock(tag, data) {
    const length = Math.min(31, data.length);
    return [((tag & 0x07) << 5) | length, ...data.slice(0, length)];
  }

  function buildAudioBlocks() {
    const sad = [0x09, 0x07, 0x07];
    const audio = dataBlock(0x01, sad);
    const speaker = dataBlock(0x04, [0x01, 0x00, 0x00]);
    return [audio, speaker];
  }

  function buildVideoDataBlock(modes, preferredMode) {
    const svds = [];
    const seen = new Set();
    const pushVic = (vic) => {
      if (!vic || vic < 1 || vic > 127) return;
      if (seen.has(vic)) return;
      seen.add(vic);
      svds.push(vic);
    };

    const preferredVic = preferredMode ? findCtaVic(preferredMode) : null;
    if (preferredVic) pushVic(preferredVic.vic);

    for (const mode of modes) {
      const vic = findCtaVic(mode);
      if (!vic) continue;
      pushVic(vic.vic);
    }

    // Keep VIC 1 for CTA-861 compatibility; revisit when DisplayID support is ubiquitous.
    pushVic(1);

    if (!svds.length) return null;
    const usedSvds = svds.slice(0, 31);
    const droppedSvds = svds.slice(31);
    return {
      block: dataBlock(0x02, usedSvds),
      usedSvds,
      droppedSvds,
      allSvds: svds,
    };
  }

  const FRL_RATE_TABLE = [
    { code: 1, rawGbps: 9 },
    { code: 2, rawGbps: 18 },
    { code: 3, rawGbps: 24 },
    { code: 4, rawGbps: 32 },
    { code: 5, rawGbps: 40 },
    { code: 6, rawGbps: 48 },
  ];
  const FRL_MAX_RAW_GBPS = 48;

  function tmdsMhzForPixelClock(pixelClockKHz, bpp) {
    const pixelClockMhz = pixelClockKHz / 1000;
    return pixelClockMhz * (bpp / 24);
  }

  function frlRawGbpsForPixelClock(pixelClockKHz, bpp) {
    const payloadGbps = (pixelClockKHz * bpp) / 1e6;
    return payloadGbps * (18 / 16);
  }

  function frlCodeForRawGbps(rawGbps) {
    for (const rate of FRL_RATE_TABLE) {
      if (rawGbps <= rate.rawGbps) return rate.code;
    }
    return null;
  }

  function formatFrlRate(code) {
    switch (code) {
      case 1:
        return "3Gx3";
      case 2:
        return "6Gx3";
      case 3:
        return "6Gx4";
      case 4:
        return "8Gx4";
      case 5:
        return "10Gx4";
      case 6:
        return "12Gx4";
      default:
        return null;
    }
  }

  function computeLinkBudgets(modeInfos, bppResolver) {
    const resolveBpp = typeof bppResolver === "function"
      ? bppResolver
      : () => bppResolver;
    let maxTmdsMhz = 0;
    let maxFrlRawGbps = 0;
    for (const info of modeInfos) {
      if (!info.pixelClockKHz) continue;
      const bpp = resolveBpp(info);
      if (!bpp) continue;
      const tmdsMhz = tmdsMhzForPixelClock(info.pixelClockKHz, bpp);
      maxTmdsMhz = Math.max(maxTmdsMhz, tmdsMhz);
      const frlRawGbps = frlRawGbpsForPixelClock(info.pixelClockKHz, bpp);
      maxFrlRawGbps = Math.max(maxFrlRawGbps, frlRawGbps);
    }
    return { maxTmdsMhz, maxFrlRawGbps };
  }

  function buildHdmiVsdb(maxTmdsMhz, deepColor) {
    const maxClock = Math.min(68, Math.ceil(maxTmdsMhz / 5));
    let flags = 0x00;
    if (deepColor) flags |= 0x18;
    return dataBlock(0x03, [0x03, 0x0c, 0x00, 0x00, 0x00, flags, maxClock]);
  }

  function buildHfVsdb({
    maxTmdsMhz,
    vrrRange,
    maxFrlRate = 0,
    dscEnabled = false,
    dscMaxSlices = 1,
    dsc10bpc = false,
  }) {
    const maxTmds = maxTmdsMhz > 0 ? Math.min(600, Math.ceil(maxTmdsMhz)) : 0;
    const maxClock = maxTmds > 0 ? Math.ceil(maxTmds / 5) : 0;
    const scdcFlags = 0x80;
    const frlFlags = (maxFrlRate & 0x0f) << 4;
    const data = [0xd8, 0x5d, 0xc4, 0x01, maxClock, scdcFlags, frlFlags];

    if (vrrRange || dscEnabled) {
      let vrrPacked = 0x00;
      let vrrMax = 0x00;
      if (vrrRange) {
        const vrrMin = Math.max(24, Math.min(48, vrrRange.min));
        vrrMax = Math.max(100, Math.min(240, vrrRange.max));
        vrrPacked = (vrrMin & 0x3f) | (((vrrMax >> 8) & 0x03) << 6);
      }
      data.push(0x00, vrrPacked, vrrMax & 0xff);
    }

    if (dscEnabled) {
      const dscFlags = 0x80 | (dsc10bpc ? 0x01 : 0x00);
      const dscMaxFrl = (maxFrlRate & 0x0f) << 4;
      const slices = Math.max(1, Math.min(16, dscMaxSlices));
      const sliceCodeMap = new Map([
        [1, 0],
        [2, 1],
        [4, 3],
        [6, 4],
        [8, 5],
        [10, 6],
        [12, 7],
        [16, 15],
      ]);
      const sliceCode = sliceCodeMap.get(slices) ?? 1;
      data.push(dscFlags, dscMaxFrl | (sliceCode & 0x0f), 0x00);
    }

    return dataBlock(0x03, data);
  }

  function buildHdrBlocks() {
    const colorimetry = dataBlock(0x07, [0x05, 0xc0, 0x00]);
    const hdr = dataBlock(0x07, [0x06, 0x04, 0x01]);
    return [colorimetry, hdr];
  }

  function buildBaseBlock(preferredDtd, range, name, extensionCount) {
    const base = new Uint8Array(128).fill(0x00);

    base.set([0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00], 0);
    base.set(encodeManufacturerId(DEFAULT_VENDOR), 8);
    base[10] = 0x01;
    base[11] = 0x00;
    base[12] = 0x01;
    base[13] = 0x00;
    base[14] = 0x00;
    base[15] = 0x00;
    base[16] = 1;
    const year = new Date().getFullYear() - 1990;
    base[17] = Math.max(0, Math.min(255, year));
    base[18] = 0x01;
    base[19] = 0x03;
    base[20] = 0x80;
    base[21] = 0x00;
    base[22] = 0x00;
    base[23] = 0x78;
    base[24] = 0x07;
    base.set(encodeChromaticity(), 25);
    base[35] = 0x00;
    base[36] = 0x00;
    base[37] = 0x00;
    for (let i = 38; i < 54; i += 2) {
      base[i] = 0x01;
      base[i + 1] = 0x01;
    }

    const descriptors = [
      preferredDtd,
      rangeDescriptor(range.minV, range.maxV, range.minH, range.maxH, range.maxClock),
      nameDescriptor(name),
      dummyDescriptor(),
    ];

    let offset = 54;
    for (const descriptor of descriptors) {
      base.set(descriptor, offset);
      offset += 18;
    }

    base[126] = extensionCount;
    base[127] = checksum(base);

    return base;
  }

  function buildCtaBlock(dataBlocks, dtds, audioEnabled, nativeDetailedCount = 0) {
    const block = new Uint8Array(128).fill(0x00);
    block[0] = 0x02;
    block[1] = 0x03;

    let flags = 0x80 | 0x30;
    if (audioEnabled) flags |= 0x40;

    let offset = 4;
    for (const dataBlockBytes of dataBlocks) {
      if (offset + dataBlockBytes.length >= 127) break;
      block.set(dataBlockBytes, offset);
      offset += dataBlockBytes.length;
    }

    block[2] = offset;

    const maxDtds = Math.floor((127 - offset) / 18);
    const includedDtds = dtds.slice(0, Math.max(0, maxDtds));
    const nativeCount = Math.min(nativeDetailedCount, includedDtds.length);
    block[3] = flags | nativeCount;

    for (const dtd of includedDtds) {
      if (offset + 18 > 127) break;
      block.set(dtd, offset);
      offset += 18;
    }

    block[127] = checksum(block);
    return block;
  }

  function buildBlockMapBlock(extensionTags) {
    const block = new Uint8Array(128).fill(0x00);
    block[0] = 0xf0;
    for (let i = 0; i < extensionTags.length && i < 126; i += 1) {
      block[1 + i] = extensionTags[i];
    }
    block[127] = checksum(block);
    return block;
  }

  function displayIdDataBlock(tag, revision, payload) {
    return [tag, revision & 0xff, payload.length & 0xff, ...payload];
  }

  function displayIdAspectCode(mode) {
    switch (approximateAspect(mode.width, mode.height)) {
      case "1:1":
        return 0;
      case "5:4":
        return 1;
      case "4:3":
        return 2;
      case "15:9":
        return 3;
      case "16:9":
        return 4;
      case "16:10":
        return 5;
      case "64:27":
        return 6;
      case "256:135":
        return 7;
      default:
        return 8;
    }
  }

  function buildDisplayIdProductIdBlock(name) {
    const oui = [0x00, 0x00, 0x00];
    const productCode = 0x0001;
    const serial = 0x00000001;
    const year = Math.max(0, Math.min(255, new Date().getFullYear() - 2000));
    const week = 1;
    const productName = name ? name.slice(0, 32) : "";
    const nameBytes = [...productName].map((char) => char.charCodeAt(0));
    const payload = [
      oui[0],
      oui[1],
      oui[2],
      productCode & 0xff,
      (productCode >> 8) & 0xff,
      serial & 0xff,
      (serial >> 8) & 0xff,
      (serial >> 16) & 0xff,
      (serial >> 24) & 0xff,
      week,
      year,
      nameBytes.length,
      ...nameBytes,
    ];
    return displayIdDataBlock(0x00, 0x00, payload);
  }

  function buildDisplayIdParametersBlock(preferredMode, deepColor) {
    const width = preferredMode ? preferredMode.width : 0;
    const height = preferredMode ? preferredMode.height : 0;
    const bpcNibble = deepColor ? 9 : 7;
    const bpcByte = (bpcNibble << 4) | bpcNibble;
    const payload = [
      0x00,
      0x00,
      0x00,
      0x00,
      width & 0xff,
      (width >> 8) & 0xff,
      height & 0xff,
      (height >> 8) & 0xff,
      0x00,
      0xff,
      0x00,
      bpcByte,
    ];
    return displayIdDataBlock(0x01, 0x00, payload);
  }

  function buildDisplayIdInterfaceBlock(deepColor, hdmiVersion) {
    const bpcFlags444 = deepColor ? 0x06 : 0x02;
    const bpcFlags422 = deepColor ? 0x03 : 0x01;
    const interfaceVersion =
      hdmiVersion === "HDMI 2.1" ? 0x21 :
      hdmiVersion === "HDMI 2.0" ? 0x20 :
      0x14;
    const payload = [
      0x71,
      interfaceVersion,
      bpcFlags444,
      bpcFlags444,
      bpcFlags422,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
    ];
    return displayIdDataBlock(0x0f, 0x00, payload);
  }

  function buildDisplayIdTimingEntry(info, preferredKey) {
    const timing = info.timing;
    const mode = info.mode;
    const encode = (value) => Math.max(1, Math.round(value)) - 1;
    const splitWithPolarity = (value, positive) => {
      const encoded = encode(value);
      const low = encoded & 0xff;
      const high = ((encoded >> 8) & 0x7f) | (positive ? 0x80 : 0x00);
      return [low, high];
    };

    const pixelClockUnits = Math.max(1, Math.round(timing.dotClockKHz / 10));
    const pixelClock = pixelClockUnits - 1;
    const hActive = encode(timing.hDisplay);
    const hBlank = encode(timing.hTotal - timing.hDisplay);
    const hFrontPorch = timing.hSyncStart - timing.hDisplay;
    const hSyncWidth = encode(timing.hSyncEnd - timing.hSyncStart);
    const vActive = encode(timing.vDisplay);
    const vBlank = encode(timing.vTotal - timing.vDisplay);
    const vFrontPorch = timing.vSyncStart - timing.vDisplay;
    const vSyncWidth = encode(timing.vSyncEnd - timing.vSyncStart);
    const aspect = displayIdAspectCode(mode);
    const preferred = Boolean(preferredKey) && info.key === preferredKey;
    const flags = (preferred ? 0x80 : 0x00) | (aspect & 0x0f);
    const [hfpLow, hfpHigh] = splitWithPolarity(hFrontPorch, timing.hSyncPositive);
    const [vfpLow, vfpHigh] = splitWithPolarity(vFrontPorch, timing.vSyncPositive);

    return new Uint8Array([
      pixelClock & 0xff,
      (pixelClock >> 8) & 0xff,
      (pixelClock >> 16) & 0xff,
      flags,
      hActive & 0xff,
      (hActive >> 8) & 0xff,
      hBlank & 0xff,
      (hBlank >> 8) & 0xff,
      hfpLow,
      hfpHigh,
      hSyncWidth & 0xff,
      (hSyncWidth >> 8) & 0xff,
      vActive & 0xff,
      (vActive >> 8) & 0xff,
      vBlank & 0xff,
      (vBlank >> 8) & 0xff,
      vfpLow,
      vfpHigh,
      vSyncWidth & 0xff,
      (vSyncWidth >> 8) & 0xff,
    ]);
  }

  function buildDisplayIdTimingBlock(infos, preferredKey) {
    const payload = [];
    for (const info of infos) {
      const entry = buildDisplayIdTimingEntry(info, preferredKey);
      payload.push(...entry);
    }
    return displayIdDataBlock(0x03, 0x00, payload);
  }

  function displayIdPayloadChecksum(block, checksumIndex) {
    let sum = 0;
    for (let i = 1; i < checksumIndex; i += 1) {
      sum += block[i];
    }
    return (256 - (sum % 256)) % 256;
  }

  function buildDisplayIdExtensionBlock({ version, productType, extensionCount, dataBlocks }) {
    const block = new Uint8Array(128).fill(0x00);
    const data = dataBlocks.flatMap((dataBlockBytes) => dataBlockBytes);
    const length = data.length;
    if (length > MAX_DISPLAYID_DATA_BYTES) {
      return null;
    }
    block[0] = 0x70;
    block[1] = version;
    block[2] = length;
    block[3] = productType;
    block[4] = extensionCount;
    block.set(data, 5);
    const checksumIndex = 5 + data.length;
    block[checksumIndex] = displayIdPayloadChecksum(block, checksumIndex);
    block[127] = checksum(block);
    return block;
  }

  function buildDisplayIdBlocks({ infos, preferredMode, deepColor, hdmiVersion, name }) {
    if (!infos.length) {
      return { blocks: [], modes: [], dropped: [] };
    }

    const preferredKey = infos.find((info) => info.key === modeKey(preferredMode))
      ? modeKey(preferredMode)
      : infos[0].key;

    const productBlock = buildDisplayIdProductIdBlock(name);
    const parametersBlock = buildDisplayIdParametersBlock(preferredMode, deepColor);
    const interfaceBlock = buildDisplayIdInterfaceBlock(deepColor, hdmiVersion);
    const requiredBytes = productBlock.length + parametersBlock.length + interfaceBlock.length;
    const baseCapacity = Math.floor((MAX_DISPLAYID_DATA_BYTES - requiredBytes - 3) / 20);
    const maxBaseTimings = Math.max(1, baseCapacity);
    const maxExtensionTimings = Math.floor((MAX_DISPLAYID_DATA_BYTES - 3) / 20);
    const remaining = infos.slice();
    const included = [];
    const dropped = [];

    const baseTimings = remaining.splice(0, maxBaseTimings);
    included.push(...baseTimings);

    const extensionBlocks = [];
    while (remaining.length) {
      const chunk = remaining.splice(0, maxExtensionTimings);
      const timingBlock = buildDisplayIdTimingBlock(chunk, preferredKey);
      const extensionBlock = buildDisplayIdExtensionBlock({
        version: DISPLAYID_VERSION,
        productType: 0x00,
        extensionCount: 0x00,
        dataBlocks: [timingBlock],
      });
      if (!extensionBlock) {
        dropped.push(...chunk);
      } else {
        extensionBlocks.push(extensionBlock);
        included.push(...chunk);
      }
    }

    const timingBlock = buildDisplayIdTimingBlock(baseTimings, preferredKey);
    const baseBlock = buildDisplayIdExtensionBlock({
      version: DISPLAYID_VERSION,
      productType: 0x03,
      extensionCount: extensionBlocks.length,
      dataBlocks: [productBlock, parametersBlock, interfaceBlock, timingBlock],
    });

    if (!baseBlock) {
      dropped.push(...baseTimings);
      return { blocks: [], modes: [], dropped: [...infos] };
    }

    return { blocks: [baseBlock, ...extensionBlocks], modes: included, dropped };
  }

  function generateEdid({ defaultMode, modes, audio, hdr, deepColor, vrr, dsc }) {
    const warnings = [];
    const modeInfos = [];
    const requestedKeys = new Set(modes.map(modeKey));

    let maxPixelClockKHz = 0;
    let minV = 240;
    let maxV = 0;
    let minH = 1000;
    let maxH = 0;

    for (const mode of modes) {
      const vic = findCtaVic(mode);
      let pixelClockKHz = 0;
      let hSyncKHz = 0;
      let timing = null;
      if (vic) {
        pixelClockKHz = vic.pixclk;
        hSyncKHz = vic.hfreq / 1000;
      } else {
        const reduced = shouldUseReducedBlanking(mode);
        timing = generateCvtTiming(mode.width, mode.height, mode.refresh, reduced);
        pixelClockKHz = timing.dotClockKHz;
        hSyncKHz = timing.hSyncKHz;
      }

      maxPixelClockKHz = Math.max(maxPixelClockKHz, pixelClockKHz);
      const refreshHz = timing ? timing.vRefreshHz : vic ? vic.refresh : mode.refresh;
      minV = Math.min(minV, refreshHz);
      maxV = Math.max(maxV, refreshHz);
      if (hSyncKHz) {
        minH = Math.min(minH, hSyncKHz);
        maxH = Math.max(maxH, hSyncKHz);
      }
      modeInfos.push({ mode, vic, pixelClockKHz, timing, key: modeKey(mode) });
    }

    const vic1 = CTA_VIC.find((entry) => entry.vic === 1);
    if (vic1) {
      minV = Math.min(minV, vic1.refresh);
      maxV = Math.max(maxV, vic1.refresh);
      minH = Math.min(minH, vic1.hfreq / 1000);
      maxH = Math.max(maxH, vic1.hfreq / 1000);
      maxPixelClockKHz = Math.max(maxPixelClockKHz, vic1.pixclk);
    }

    const unsupported = modeInfos.filter(
      (info) => !info.vic && info.timing && info.timing.dotClockKHz > MAX_DTD_PIXEL_CLOCK_KHZ
    );
    const maxModeWidth = modeInfos.reduce(
      (max, info) => Math.max(max, info.mode.width),
      0
    );

    let vrrRange = null;
    if (vrr) {
      const range = deriveVrrRange(modes);
      const min = Math.max(24, Math.min(48, range.min));
      const max = Math.max(100, Math.min(240, range.max));
      if (max <= min) {
        warnings.push("VRR needs at least two refresh rates. Add another rate to create a range.");
      } else {
        vrrRange = { min, max };
      }
      if (range.min !== min || range.max !== max) {
        warnings.push("VRR range clamped to supported limits (24-48 Hz min, 100-240 Hz max).");
      }
    }

    const bppFull = deepColor ? 30 : 24;
    const bpp420 = deepColor ? 15 : 12;
    const dscTargetBpp = deepColor ? 10 : 8;
    const linkFull = computeLinkBudgets(modeInfos, bppFull);
    const dscRequired = linkFull.maxFrlRawGbps > FRL_MAX_RAW_GBPS;
    const dscEnabled = Boolean(dsc) && dscRequired;

    const modeLinkInfo = new Map();
    for (const info of modeInfos) {
      if (!info.pixelClockKHz) continue;
      const fullRaw = frlRawGbpsForPixelClock(info.pixelClockKHz, bppFull);
      const y420Raw = frlRawGbpsForPixelClock(info.pixelClockKHz, bpp420);
      modeLinkInfo.set(info, { fullRaw, y420Raw });
    }

    let chromaAssumed = "4:4:4";
    const useY420Fallback = dscRequired && !dscEnabled;
    if (useY420Fallback) {
      chromaAssumed = "4:2:0";
      let usedY420 = false;
      let y420StillOver = false;
      for (const info of modeInfos) {
        const link = modeLinkInfo.get(info);
        if (!link || link.fullRaw <= FRL_MAX_RAW_GBPS) continue;
        usedY420 = true;
        if (link.y420Raw > FRL_MAX_RAW_GBPS) y420StillOver = true;
      }
      if (usedY420) {
        warnings.push("DSC off, assuming 4:2:0: DSC required by bandwidth but you disabled it.");
      }
      if (y420StillOver) {
        warnings.push(
          "Some modes still exceed HDMI 2.1 bandwidth even with 4:2:0 and may not work."
        );
      }
    }

    const effectiveBpp = (info) => {
      const link = modeLinkInfo.get(info);
      if (!link) return bppFull;
      if (dscEnabled && link.fullRaw > FRL_MAX_RAW_GBPS) return dscTargetBpp;
      if (useY420Fallback && link.fullRaw > FRL_MAX_RAW_GBPS) return bpp420;
      return bppFull;
    };

    const linkMetrics = computeLinkBudgets(modeInfos, effectiveBpp);

    const maxTmdsMhz = linkMetrics.maxTmdsMhz;
    const maxTmdsMhzRounded = Math.ceil(maxTmdsMhz);
    const requiresFrl = maxTmdsMhz > 600;
    let maxFrlRate = 0;
    if (requiresFrl || dscEnabled) {
      const frlCode = frlCodeForRawGbps(linkMetrics.maxFrlRawGbps);
      if (frlCode === null) {
        maxFrlRate = 6;
        if (dscEnabled) {
          warnings.push(
            "Some modes still exceed HDMI 2.1 bandwidth even with DSC and may not work."
          );
        }
      } else {
        maxFrlRate = frlCode;
      }
    }

    const needsHfVsdb = Boolean(vrrRange) || requiresFrl || dscEnabled;
    const hdmiVersion =
      requiresFrl || vrrRange || dscEnabled ? "HDMI 2.1" :
      maxTmdsMhz > 340 ? "HDMI 2.0" :
      "HDMI 1.4";

    const maxTmdsHdmiMhz = Math.min(340, maxTmdsMhzRounded);
    let maxTmdsHfMhz = null;
    if (needsHfVsdb) {
      if (maxFrlRate >= 2) {
        maxTmdsHfMhz = 600;
      } else if (maxTmdsMhzRounded > 340) {
        maxTmdsHfMhz = Math.min(600, maxTmdsMhzRounded);
      } else {
        maxTmdsHfMhz = 0;
      }
    }

    const dtdCandidates = modeInfos
      .map((info) => {
        if (info.timing) return info;
        const reduced = shouldUseReducedBlanking(info.mode);
        const timing = generateCvtTiming(
          info.mode.width,
          info.mode.height,
          info.mode.refresh,
          reduced
        );
        return { ...info, timing };
      })
      .filter((info) => info.timing.dotClockKHz <= MAX_DTD_PIXEL_CLOCK_KHZ);

    const defaultKey = modeKey(defaultMode);

    let preferred = dtdCandidates.find(
      (info) => info.key === defaultKey
    );

    if (!preferred) {
      warnings.push(
        "Default mode can't fit base EDID timing limits. Lower resolution or refresh rate, or a fallback will be used."
      );
      preferred = dtdCandidates[0];
    }

    if (!preferred) {
      warnings.push("No mode fits in the EDID base block. Falling back to 640x480@60.");
      preferred = {
        mode: { width: 640, height: 480, refresh: 60 },
        timing: generateCvtTiming(640, 480, 60, false),
      };
    }

    const preferredKey = modeKey(preferred.mode);
    const preferredDtd = timingToDtd(preferred.timing);
    if (preferred.timing) {
      minV = Math.min(minV, preferred.timing.vRefreshHz);
      maxV = Math.max(maxV, preferred.timing.vRefreshHz);
      minH = Math.min(minH, preferred.timing.hSyncKHz);
      maxH = Math.max(maxH, preferred.timing.hSyncKHz);
    }

    const dataBlocks = [];
    const videoBlock = buildVideoDataBlock(modes, defaultMode);
    if (videoBlock) dataBlocks.push(videoBlock.block);
    if (useY420Fallback && videoBlock) {
      const mapBytes = Math.ceil(videoBlock.usedSvds.length / 8);
      const bitmap = new Array(mapBytes).fill(0);
      let hasBits = false;
      for (let i = 0; i < videoBlock.usedSvds.length; i += 1) {
        const vic = videoBlock.usedSvds[i];
        const vicInfo = CTA_VIC.find((entry) => entry.vic === vic);
        if (!vicInfo) continue;
        const fullRaw = frlRawGbpsForPixelClock(vicInfo.pixclk, bppFull);
        const y420Raw = frlRawGbpsForPixelClock(vicInfo.pixclk, bpp420);
        if (fullRaw <= FRL_MAX_RAW_GBPS) continue;
        if (y420Raw > FRL_MAX_RAW_GBPS) continue;
        bitmap[Math.floor(i / 8)] |= 1 << (i % 8);
        hasBits = true;
      }
      if (hasBits) {
        dataBlocks.push(dataBlock(0x07, [0x0f, ...bitmap]));
      }
    }
    if (audio) dataBlocks.push(...buildAudioBlocks());
    dataBlocks.push(dataBlock(0x07, [0x00, 0xca]));

    const hdmiVsdb = buildHdmiVsdb(maxTmdsHdmiMhz, deepColor);
    dataBlocks.push(hdmiVsdb);

    const dscMaxSlices = dscEnabled
      ? maxModeWidth >= 7680
        ? 8
        : maxModeWidth >= 3840
          ? 4
          : 2
      : 1;
    const dsc10bpc = Boolean(deepColor);

    if (needsHfVsdb) {
      dataBlocks.push(
        buildHfVsdb({
          maxTmdsMhz: maxTmdsHfMhz ?? 0,
          vrrRange,
          maxFrlRate,
          dscEnabled,
          dscMaxSlices,
          dsc10bpc,
        })
      );
    }

    if (hdr) dataBlocks.push(...buildHdrBlocks());

    const includeCtaPreferred = true;
    const maxAdditionalDtds = includeCtaPreferred ? 5 : 6;
    const additionalDtdInfos = dtdCandidates
      .filter((info) => info !== preferred)
      .filter((info) => !info.vic)
      .slice(0, maxAdditionalDtds);
    const additionalDtds = additionalDtdInfos.map((info) => timingToDtd(info.timing));

    const ctaDtds = includeCtaPreferred
      ? [preferredDtd, ...additionalDtds]
      : additionalDtds;
    const nativeDetailedCount =
      includeCtaPreferred && preferredKey === defaultKey ? 1 : 0;
    const ctaBlock = buildCtaBlock(
      dataBlocks,
      ctaDtds,
      audio,
      nativeDetailedCount
    );

    const usedVics = videoBlock ? videoBlock.usedSvds : [];
    const droppedVics = videoBlock ? videoBlock.droppedSvds : [];
    const usedVicsSet = new Set(usedVics);
    const droppedVicsSet = new Set(droppedVics);

    const keptVdbInfos = modeInfos.filter(
      (info) => info.vic && usedVicsSet.has(info.vic.vic)
    );
    const droppedVdbInfos = modeInfos.filter(
      (info) => info.vic && droppedVicsSet.has(info.vic.vic)
    );

    const keptNonVicInfos = [];
    if (!preferred.vic && requestedKeys.has(preferredKey)) {
      keptNonVicInfos.push(preferred);
    }
    for (const info of additionalDtdInfos) {
      keptNonVicInfos.push(info);
    }
    const keptNonVicKeys = new Set(keptNonVicInfos.map((info) => info.key));
    const eligibleNonVicInfos = dtdCandidates.filter((info) => !info.vic);
    const droppedDtdInfos = eligibleNonVicInfos.filter(
      (info) => !keptNonVicKeys.has(info.key)
    );

    const advertisedKeys = new Set();
    for (const info of keptVdbInfos) advertisedKeys.add(info.key);
    for (const info of keptNonVicInfos) advertisedKeys.add(info.key);
    const advertisedModes = modes.filter((mode) => advertisedKeys.has(modeKey(mode)));

    const displayIdCandidates = modeInfos.filter(
      (info) => requestedKeys.has(info.key) && !advertisedKeys.has(info.key)
    );
    const displayIdInfos = displayIdCandidates.map((info) => {
      if (info.timing) return info;
      const reduced = shouldUseReducedBlanking(info.mode);
      const timing = generateCvtTiming(
        info.mode.width,
        info.mode.height,
        info.mode.refresh,
        reduced
      );
      return { ...info, timing };
    });
    const displayIdResult = buildDisplayIdBlocks({
      infos: displayIdInfos,
      preferredMode: defaultMode,
      deepColor,
      hdmiVersion,
      name: DEFAULT_NAME,
    });
    const displayIdBlocks = displayIdResult.blocks;
    const displayIdKeys = new Set(displayIdResult.modes.map((info) => info.key));
    const displayIdModes = displayIdResult.modes.map((info) => info.mode);

    const maxClockMHz = maxPixelClockKHz / 1000;
    const rangeMaxClock = Math.min(2550, Math.ceil(maxClockMHz));
    if (maxClockMHz > 2550) {
      warnings.push("Display range max clock capped at 2550 MHz (EDID limit).");
    }
    const range = {
      minV: Math.max(24, Math.floor(minV)),
      maxV: Math.min(240, Math.ceil(maxV)),
      minH: Math.max(15, Math.floor(minH)),
      maxH: Math.min(255, Math.ceil(maxH)),
      maxClock: rangeMaxClock,
    };

    const extensionBlocks = [ctaBlock, ...displayIdBlocks];
    if (extensionBlocks.length > 1) {
      const extensionTags = extensionBlocks.map((block) => block[0]);
      extensionBlocks.unshift(buildBlockMapBlock(extensionTags));
    }
    const baseBlock = buildBaseBlock(
      preferredDtd,
      range,
      DEFAULT_NAME,
      extensionBlocks.length
    );
    const edid = new Uint8Array((extensionBlocks.length + 1) * 128);
    edid.set(baseBlock, 0);
    extensionBlocks.forEach((block, index) => {
      edid.set(block, (index + 1) * 128);
    });

    const formatInfoList = (infos) =>
      infos.length ? infos.map((info) => formatMode(info.mode)).join(", ") : "None";

    const droppedAfterDisplayId = (infos) =>
      infos.filter((info) => !displayIdKeys.has(info.key));

    const droppedVdbFinal = droppedAfterDisplayId(droppedVdbInfos);
    if (droppedVdbFinal.length) {
      warnings.push(
        `CTA can list up to 31 standard modes; extras were dropped: ${formatInfoList(droppedVdbFinal)}. Try fewer modes or lower refresh rates.`
      );
    }

    const droppedDtdFinal = droppedAfterDisplayId(droppedDtdInfos);
    if (droppedDtdFinal.length) {
      warnings.push(
        `CTA has room for ${maxAdditionalDtds} additional detailed timings; extras were dropped: ${formatInfoList(droppedDtdFinal)}. Try fewer custom modes.`
      );
    }

    const droppedUnsupported = droppedAfterDisplayId(unsupported);
    if (droppedUnsupported.length) {
      warnings.push(
        `Some modes couldn't fit in CTA or DisplayID blocks; dropped: ${formatInfoList(droppedUnsupported)}. Try fewer modes or lower refresh/resolution.`
      );
    }

    if (displayIdResult.dropped.length) {
      warnings.push(
        `DisplayID ran out of space; dropped: ${formatInfoList(displayIdResult.dropped)}. Try fewer modes or lower refresh rates.`
      );
    }

    const frlRateLabel = formatFrlRate(maxFrlRate);
    const dscLabel = dscEnabled
      ? "On"
      : dscRequired
        ? "Off (4:2:0)"
        : "Off";
    const metadataTmdsHfMhz = maxTmdsHfMhz && maxTmdsHfMhz > 0 ? maxTmdsHfMhz : null;

    const summaryLines = [
      `Preferred timing: ${formatMode(preferred.mode)} (DTD)`,
      `CTA modes: ${advertisedModes.length ? advertisedModes.map(formatMode).join(", ") : "None"}`,
      `DisplayID modes: ${displayIdModes.length ? displayIdModes.map(formatMode).join(", ") : "None"}`,
      `CTA extension: ${audio ? "Audio" : "No audio"}${hdr ? " + HDR10" : ""}`,
      `Color depth: ${deepColor ? "10-bit" : "8-bit"}`,
      `VRR: ${vrrRange ? `${vrrRange.min}-${vrrRange.max} Hz` : "Off"}`,
      `Required link: ${hdmiVersion}`,
      `FRL: ${frlRateLabel || "Not advertised"}`,
      `DSC: ${dscLabel}`,
    ];

    const validation = validateEdid(edid);
    summaryLines.push(
      validation.issues.length ? "Validation: Issues found" : "Validation: OK"
    );
    if (validation.issues.length) {
      warnings.push(...validation.issues);
    }

    return {
      bytes: edid,
      summaryLines,
      warnings,
      hdmiVersion,
      preferredMode: preferred.mode,
      advertisedModes,
      metadata: {
        hdmiVersion,
        maxPixelClockKHz,
        maxTmdsHdmiMhz,
        maxTmdsHfMhz: metadataTmdsHfMhz,
        vrrRange,
        frlAdvertised: Boolean(frlRateLabel),
        frlRate: frlRateLabel,
        dscRequired,
        dscEnabled,
        chromaAssumed,
        displayId: displayIdBlocks.length
          ? { blocks: displayIdBlocks.length, modes: displayIdModes }
          : null,
      },
      features: {
        audio,
        hdr,
        deepColor,
        vrr: Boolean(vrrRange),
        dsc: dscEnabled,
      },
    };
  }

  function formatHex(bytes) {
    const lines = [];
    for (let i = 0; i < bytes.length; i += 16) {
      const chunk = bytes.slice(i, i + 16);
      lines.push([...chunk].map((b) => b.toString(16).padStart(2, "0")).join(" "));
    }
    return lines.join("\n");
  }

  function validateEdid(bytes) {
    const issues = [];
    if (!bytes || bytes.length < 128 || bytes.length % 128 !== 0) {
      issues.push("EDID length is not a multiple of 128 bytes.");
      return { issues };
    }

    const header = [0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00];
    for (let i = 0; i < header.length; i += 1) {
      if (bytes[i] !== header[i]) {
        issues.push("Base block header is invalid.");
        break;
      }
    }

    const extensionCount = bytes[126];
    const expectedLength = (extensionCount + 1) * 128;
    if (bytes.length < expectedLength) {
      issues.push("Extension count does not match EDID length.");
    }

    const blocks = Math.min(extensionCount + 1, bytes.length / 128);
    for (let blockIndex = 0; blockIndex < blocks; blockIndex += 1) {
      const start = blockIndex * 128;
      const block = bytes.slice(start, start + 128);
      const sum = block.reduce((acc, b) => acc + b, 0) % 256;
      if (sum !== 0) {
        issues.push(`Checksum failed in block ${blockIndex}.`);
      }

      if (blockIndex > 0 && block[0] === 0x02) {
        const dtdOffset = block[2];
        if (dtdOffset < 4 || dtdOffset > 127) {
          issues.push(`CTA block ${blockIndex} has an invalid DTD offset.`);
          continue;
        }
        let idx = 4;
        while (idx < dtdOffset) {
          const length = block[idx] & 0x1f;
          idx += 1 + length;
        }
        if (idx !== dtdOffset) {
          issues.push(`CTA block ${blockIndex} data block lengths are invalid.`);
        }
      }
    }

    return { issues };
  }

  return {
    generateEdid,
    formatHex,
    validateEdid,
  };
});
