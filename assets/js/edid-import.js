(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(root);
  } else {
    root.EdidImport = factory(root);
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";

  const HEADER = [0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00];
  // Byte, bit, width, height, refresh; the one interlaced established mode is separate.
  const ESTABLISHED = [
    [35, 7, 720, 400, 70], [35, 6, 720, 400, 88],
    [35, 5, 640, 480, 60], [35, 4, 640, 480, 67],
    [35, 3, 640, 480, 72], [35, 2, 640, 480, 75],
    [35, 1, 800, 600, 56], [35, 0, 800, 600, 60],
    [36, 7, 800, 600, 72], [36, 6, 800, 600, 75],
    [36, 5, 832, 624, 75], [36, 3, 1024, 768, 60],
    [36, 2, 1024, 768, 70], [36, 1, 1024, 768, 75],
    [36, 0, 1280, 1024, 75], [37, 7, 1152, 870, 75],
  ];
  // Check the VIC itself: the shared progressive table also mistakenly includes VICs 44/45.
  const INTERLACED_VICS = new Set([5, 6, 7, 10, 11, 20, 21, 22, 25, 26, 39, 40, 44, 45, 46, 50, 51, 54, 55, 58, 59]);
  const PRIORITY = { fallback: 0, detailed: 10, native: 20, displayId: 25, base: 30, cta: 40, preference: 50 };

  function parseEdid(bytes) {
    validateBinary(bytes);
    const context = {
      settings: { audio: false, hdr: false, deepColor: false, vrr: false, dsc: false, listedModesOnly: true },
      modes: new Map(),
      preferred: null,
      warnings: new Set(),
      vics: new Map((root.CTA_VIC || []).map((entry) => [entry.vic, entry])),
      ctaSeen: false,
      firstSvd: true,
      preferFirstSvd: false,
      dtds: [],
      preferences: [],
    };
    parseBase(bytes.subarray(0, 128), context);
    for (let index = 1; index < bytes.length / 128; index += 1) {
      const block = bytes.subarray(index * 128, (index + 1) * 128);
      if (block[0] === 0x02) parseCta(block, context);
      else if (block[0] === 0x70) parseDisplayId(block, context);
      else if (block[0] !== 0xf0) warn(context, "Unsupported EDID extensions were skipped.");
    }
    applyPreferences(context);
    if (!context.modes.size) throw new Error("No usable progressive modes were found in this EDID.");
    const defaultMode = context.preferred.mode;
    const modes = [defaultMode, ...[...context.modes.values()].filter((mode) => mode !== defaultMode)];
    return { settings: { defaultMode, modes, ...context.settings }, warnings: [...context.warnings] };
  }

  function validateBinary(bytes) {
    if (!(bytes instanceof Uint8Array)) throw new Error("Choose a binary EDID file.");
    if (bytes.length < 128 || bytes.length % 128 !== 0) {
      throw new Error("EDID files must contain complete 128-byte blocks.");
    }
    if (bytes.length > 256 * 128) throw new Error("EDID files cannot exceed 256 blocks (32 KiB).");
    if (HEADER.some((value, index) => bytes[index] !== value)) throw new Error("The EDID header is invalid.");
    if (bytes.length !== (bytes[126] + 1) * 128) throw new Error("The EDID block count does not match the file size.");
    for (let index = 0; index < bytes.length / 128; index += 1) {
      if (sum(bytes.subarray(index * 128, (index + 1) * 128)) !== 0) {
        throw new Error(`EDID checksum failed in block ${index}.`);
      }
    }
    if (bytes[18] !== 1 || bytes[19] > 4) throw new Error("Only EDID versions 1.0–1.4 are supported.");
  }

  function parseBase(block, context) {
    const revision = block[19];
    context.settings.listedModesOnly = !(block[24] & 0x01);
    if (revision >= 4 && (block[20] & 0x80)) {
      const depth = (block[20] >> 4) & 0x07;
      if (depth === 3) context.settings.deepColor = true;
      if (depth > 3 && depth < 7) warn(context, "Color depths other than 8-bit and 10-bit were not imported.");
    }
    for (let offset = 54; offset < 126; offset += 18) {
      const descriptor = block.subarray(offset, offset + 18);
      if (descriptor[0] || descriptor[1]) {
        const preferred = offset === 54 && (revision >= 4 || (block[24] & 0x02));
        const mode = parseDtd(descriptor, context, preferred ? PRIORITY.base : PRIORITY.detailed);
        context.dtds.push(mode);
      } else if (descriptor[3] === 0xfd) {
        if ([0x00, 0x02, 0x04].includes(descriptor[10])) context.settings.listedModesOnly = false;
      } else if (descriptor[3] === 0xfa) {
        parseStandard(descriptor.subarray(5, 17), revision, context);
      } else if (![0x00, 0x10, 0xfc, 0xfe, 0xff].includes(descriptor[3])) {
        warn(context, "Unsupported base-block timing descriptors were skipped.");
      }
    }
    parseStandard(block.subarray(38, 54), revision, context);
    for (const [byte, bit, width, height, refresh] of ESTABLISHED) {
      if (block[byte] & (1 << bit)) addMode(context, width, height, refresh);
    }
    if (block[36] & 0x10) warn(context, "Interlaced modes were skipped.");
  }

  function parseStandard(bytes, revision, context) {
    for (let index = 0; index < bytes.length; index += 2) {
      const first = bytes[index];
      const second = bytes[index + 1];
      if (first === 1 && second === 1) continue;
      if (first <= 1) {
        warn(context, "Invalid standard timings were skipped.");
        continue;
      }
      const width = (first + 31) * 8;
      const ratios = [revision < 3 ? 1 : 10 / 16, 3 / 4, 4 / 5, 9 / 16];
      addMode(context, width, Math.floor(width * ratios[second >> 6]), (second & 0x3f) + 60);
    }
  }

  function parseDtd(bytes, context, priority = PRIORITY.fallback) {
    const width = bytes[2] | ((bytes[4] & 0xf0) << 4);
    const hBlank = bytes[3] | ((bytes[4] & 0x0f) << 8);
    const height = bytes[5] | ((bytes[7] & 0xf0) << 4);
    const vBlank = bytes[6] | ((bytes[7] & 0x0f) << 8);
    if (!width || !height || !hBlank || !vBlank) throw new Error("An EDID detailed timing is invalid.");
    if (bytes[17] & 0x80) {
      warn(context, "Interlaced modes were skipped.");
      return null;
    }
    if (bytes[17] & 0x60) warn(context, "Stereo/3D capabilities were not imported.");
    const clockHz = little16(bytes, 0) * 10000;
    return addMode(context, width, height, clockHz / ((width + hBlank) * (height + vBlank)), priority);
  }

  function parseCta(block, context) {
    const revision = block[1];
    const offset = block[2];
    if (!revision || (offset !== 0 && (offset < 4 || offset > 127))) {
      throw new Error("A CTA extension has an invalid header or timing offset.");
    }
    if (!offset) requireZero(block.subarray(4, 127), "A CTA extension has nonzero padding.");
    if (revision > 3) {
      warn(context, "An unsupported CTA extension revision was skipped.");
      return;
    }
    const firstCta = !context.ctaSeen;
    context.ctaSeen = true;
    if (revision >= 2 && (block[3] & 0x40)) context.settings.audio = true;
    // With no native DTDs, CTA's first SVD takes precedence over the base preferred DTD.
    if (firstCta) context.preferFirstSvd = !(block[3] & 0x0f);
    if (!offset) return;
    if (revision >= 3) {
      for (let index = 4; index < offset;) {
        const tag = block[index] >> 5;
        const length = block[index] & 0x1f;
        const end = index + 1 + length;
        if (end > offset) throw new Error("A CTA data block extends past the timing offset.");
        if (!block[index]) {
          requireZero(block.subarray(index, offset), "A CTA extension has invalid data-block padding.");
          break;
        }
        const data = block.subarray(index + 1, end);
        if (tag === 2) {
          if (!length) throw new Error("A CTA video data block is empty.");
          for (const svd of data) {
            // Only VICs 1–64 have an optional native bit; 193–253 are full-byte VICs.
            const nativeEncoding = (svd & 0x7f) <= 64;
            const vic = nativeEncoding ? svd & 0x7f : svd;
            const native = nativeEncoding && (svd & 0x80);
            const priority = context.firstSvd && context.preferFirstSvd ? PRIORITY.cta : native ? PRIORITY.native : PRIORITY.fallback;
            if (vic) {
              addVic(context, vic, priority);
              context.firstSvd = false;
            }
          }
        } else {
          parseCtaDataBlock(tag, data, context);
        }
        index = end;
      }
    } else if (offset > 4) {
      warn(context, "Legacy CTA timing descriptors were skipped.");
    }
    let index = offset;
    while (index + 18 <= 127 && (block[index] || block[index + 1])) {
      const mode = parseDtd(block.subarray(index, index + 18), context, PRIORITY.detailed);
      context.dtds.push(mode);
      index += 18;
    }
    requireZero(block.subarray(index, 127), "A CTA extension has invalid or incomplete detailed timings.");
  }

  function parseCtaDataBlock(tag, data, context) {
    if (tag === 1) {
      if (!data.length || data.length % 3) throw new Error("A CTA audio data block has an invalid length.");
      for (let index = 0; index < data.length; index += 3) {
        const lpcm = ((data[index] >> 3) & 0x0f) === 1;
        if (lpcm && (data[index] & 0x07) >= 1 && (data[index + 1] & 0x07) === 0x07 && (data[index + 2] & 0x01)) {
          context.settings.audio = true;
        }
        if (!lpcm || data[index] !== 0x09 || data[index + 1] !== 0x07 || data[index + 2] !== 0x07) {
          warn(context, "Only basic stereo LPCM audio settings can be imported.");
        }
      }
    } else if (tag === 3) {
      if (data.length < 3) throw new Error("A CTA vendor data block is truncated.");
      const oui = data[0] | (data[1] << 8) | (data[2] << 16);
      if (oui === 0x000c03) parseHdmi(data, context);
      else if (oui === 0xc45dd8) parseForum(data.subarray(3), context);
      else warn(context, "Unsupported vendor-specific capabilities were skipped.");
    } else if (tag === 4) {
      if (data.length !== 3) throw new Error("A CTA speaker data block has an invalid length.");
      if (data[0] !== 1 || data[1] || data[2]) warn(context, "Multichannel speaker information was not imported.");
    } else if (tag === 7) {
      parseCtaExtended(data, context);
    } else {
      warn(context, "Unsupported CTA data blocks were skipped.");
    }
  }

  function parseCtaExtended(data, context) {
    if (!data.length) throw new Error("A CTA extended data block is empty.");
    const tag = data[0];
    if (tag === 0x00 || tag === 0x05 || tag === 0x06) {
      const minimum = tag === 0x00 ? 2 : 3;
      if (data.length < minimum) throw new Error("A CTA video capability data block is truncated.");
      if (tag === 0x06) {
        if (data[1] & 0x04) context.settings.hdr = true;
        if (data[1] & 0x08) warn(context, "HDR formats other than PQ/HDR10 were not imported.");
      }
    } else if (tag === 0x0d) {
      if (data.length < 2) throw new Error("A CTA video preference data block is empty.");
      context.preferences.push(...data.subarray(1));
    } else if (tag === 0x79) {
      if (data.length < 7) throw new Error("An HDMI Forum capability data block is truncated.");
      parseForum(data.subarray(3), context);
    } else if (tag === 0x0e || tag === 0x0f) {
      if (tag === 0x0e && data.length < 2) throw new Error("A CTA 4:2:0 video data block is empty.");
      warn(context, "YCbCr 4:2:0-only modes and chroma restrictions were not imported.");
    } else {
      warn(context, "Unsupported CTA data blocks were skipped.");
    }
  }

  function parseHdmi(data, context) {
    if (data.length < 5) throw new Error("An HDMI vendor data block is truncated.");
    if (data.length >= 6) {
      if (data[5] & 0x10) context.settings.deepColor = true;
      if (data[5] & 0x60) warn(context, "Color depths other than 8-bit and 10-bit were not imported.");
    }
    if (data.length < 8) return;
    let index = 8;
    if (data[7] & 0x80) index += 2;
    if (data[7] & 0x40) index += 2;
    if (index > data.length) throw new Error("HDMI latency information is truncated.");
    if (!(data[7] & 0x20)) return;
    if (index + 2 > data.length) throw new Error("HDMI video information is truncated.");
    const flags = data[index];
    const lengths = data[index + 1];
    index += 2;
    const vicCount = lengths >> 5;
    const stereoLength = lengths & 0x1f;
    if (index + vicCount + stereoLength > data.length) throw new Error("HDMI video information has invalid lengths.");
    const hdmiVics = [0, 95, 94, 93, 98];
    for (const vic of data.subarray(index, index + vicCount)) addVic(context, hdmiVics[vic] || 0);
    if ((flags & 0x80) || stereoLength) warn(context, "Stereo/3D capabilities were not imported.");
  }

  function parseForum(data, context) {
    if (data.length < 4 || [6, 8, 9].includes(data.length)) throw new Error("An HDMI Forum capability data block is truncated.");
    if (data[0] !== 1) {
      warn(context, "An unsupported HDMI Forum capability version was skipped.");
      return;
    }
    // The 4:2:0 and DSC-specific 10-bit flags do not establish uncompressed RGB 10-bit support.
    if (data[3] & 0x07) warn(context, "YCbCr 4:2:0-only modes and chroma restrictions were not imported.");
    if (data.length >= 7) {
      const min = data[5] & 0x3f;
      const max = ((data[5] & 0xc0) << 2) | data[6];
      if (min > 0 && min <= 48 && max >= 100 && max > min) context.settings.vrr = true;
      else if (min || max) warn(context, "An invalid HDMI VRR range was not imported.");
    }
    if (data.length >= 10 && (data[7] & 0x80)) context.settings.dsc = true;
  }

  function parseDisplayId(block, context) {
    const end = 5 + block[2];
    if (end > 126) throw new Error("A DisplayID payload is too long.");
    if (sum(block.subarray(1, end + 1)) !== 0) throw new Error("A DisplayID payload checksum is invalid.");
    requireZero(block.subarray(end + 1, 127), "A DisplayID extension has nonzero padding.");
    const supported = [0x10, 0x11, 0x12, 0x13, 0x20].includes(block[1]);
    if (!supported) warn(context, "An unsupported DisplayID version was skipped.");
    for (let index = 5; index < end;) {
      if (isZero(block.subarray(index, end))) break;
      if (index + 3 > end || index + 3 + block[index + 2] > end) {
        throw new Error("A DisplayID data block extends past its payload.");
      }
      const tag = block[index];
      const revision = block[index + 1];
      const data = block.subarray(index + 3, index + 3 + block[index + 2]);
      if (supported) parseDisplayIdData(tag, revision, data, block[1], context);
      index += 3 + data.length;
    }
  }

  function parseDisplayIdData(tag, revision, data, version, context) {
    const type1 = version < 0x20 && tag === 0x03;
    const type7 = version >= 0x20 && tag === 0x22;
    if (type1 || type7) {
      const size = type1 ? 20 : 20 + ((revision & 0x70) >> 4);
      if (!data.length || data.length % size) throw new Error("A DisplayID detailed timing block has an invalid length.");
      const blockRevision = revision & 0x07;
      if ((type1 && revision > 1) || (type7 && (blockRevision > 2 || (revision & 0x80)))) {
        warn(context, "Unsupported DisplayID timing revisions were skipped.");
        return;
      }
      for (let index = 0; index < data.length; index += size) {
        const timing = data.subarray(index, index + size);
        if (timing[3] & 0x10) {
          warn(context, "Interlaced modes were skipped.");
          continue;
        }
        if (blockRevision >= 2 && (timing[3] & 0x80)) {
          warn(context, "YCbCr 4:2:0-only modes and chroma restrictions were not imported.");
          continue;
        }
        if (timing[3] & 0x60) warn(context, "Stereo/3D capabilities were not imported.");
        const width = little16(timing, 4) + 1;
        const height = little16(timing, 12) + 1;
        const hTotal = width + little16(timing, 6) + 1;
        const vTotal = height + little16(timing, 14) + 1;
        const clock = (1 + timing[0] + (timing[1] << 8) + (timing[2] << 16)) * (type1 ? 10000 : 1000);
        // DisplayID has its own preference list; do not override a usable base/CTA preference.
        // The generator also marks a secondary DisplayID-only mode preferred in overflow blocks.
        const priority = blockRevision < 2 && (timing[3] & 0x80) ? PRIORITY.displayId : PRIORITY.detailed;
        addMode(context, width, height, clock / (hTotal * vTotal), priority);
      }
    } else if (version < 0x20 && tag === 0x01 && revision === 0) {
      if (data.length !== 12) throw new Error("A DisplayID display parameters block has an invalid length.");
      if (((data[11] >> 4) & 0x0f) === 9) context.settings.deepColor = true;
    } else if (version < 0x20 && tag === 0x0f && revision === 0) {
      if (data.length !== 10) throw new Error("A DisplayID interface block has an invalid length.");
      if (data[2] & 0x04) context.settings.deepColor = true;
    } else if (![0x00, 0x0a, 0x0b, 0x20].includes(tag)) {
      warn(context, "Unsupported DisplayID data blocks were skipped.");
    }
  }

  function applyPreferences(context) {
    for (const reference of context.preferences) {
      let mode = null;
      if ((reference >= 1 && reference <= 127) || (reference >= 193 && reference <= 253)) {
        mode = addVic(context, reference);
      } else if (reference >= 129 && reference <= 144) {
        mode = context.dtds[reference - 129];
        if (!mode) warn(context, "Unresolved CTA video preference references were skipped.");
      } else {
        warn(context, "Unsupported CTA video preference references were skipped.");
      }
      if (mode) {
        context.preferred = { mode, priority: PRIORITY.preference };
        return;
      }
    }
  }

  function addVic(context, vic, priority = PRIORITY.fallback) {
    const entry = context.vics.get(vic);
    if (INTERLACED_VICS.has(vic) || (entry && entry.interlaced)) {
      warn(context, "Interlaced modes were skipped.");
      return null;
    }
    if (!entry) {
      warn(context, "Unrecognized CTA video modes were skipped.");
      return null;
    }
    return addMode(context, entry.width, entry.height, entry.refresh, priority);
  }

  function addMode(context, width, height, rawRefresh, priority = PRIORITY.fallback) {
    const refresh = Math.round(rawRefresh);
    if (!Number.isFinite(rawRefresh) || width < 320 || width > 7680 || height < 200 || height > 4320 || refresh < 24 || refresh > 240) {
      warn(context, "Modes outside the supported 320–7680 × 200–4320, 24–240 Hz range were skipped.");
      return null;
    }
    if (Math.abs(rawRefresh - refresh) > 0.01) warn(context, "Fractional refresh rates were rounded to whole Hz.");
    const key = `${width}x${height}@${refresh}`;
    if (!context.modes.has(key)) context.modes.set(key, { width, height, refresh });
    const mode = context.modes.get(key);
    if (!context.preferred || priority > context.preferred.priority) context.preferred = { mode, priority };
    return mode;
  }

  function little16(bytes, offset) {
    return bytes[offset] | (bytes[offset + 1] << 8);
  }

  function sum(bytes) {
    return bytes.reduce((total, value) => total + value, 0) & 0xff;
  }

  function isZero(bytes) {
    return bytes.every((value) => value === 0);
  }

  function requireZero(bytes, message) {
    if (!isZero(bytes)) throw new Error(message);
  }

  function warn(context, message) {
    context.warnings.add(message);
  }

  return { parseEdid };
});
