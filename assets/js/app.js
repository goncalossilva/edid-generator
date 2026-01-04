const addModeButton = document.getElementById("add-mode");
const extraModes = document.getElementById("extra-modes");
const audioToggle = document.getElementById("audio-toggle");
const hdrToggle = document.getElementById("hdr-toggle");
const deepColorToggle = document.getElementById("deep-color-toggle");
const dscToggle = document.getElementById("dsc-toggle");
const vrrToggle = document.getElementById("vrr-toggle");
const listedModesToggle = document.getElementById("listed-modes-toggle");
const summary = document.getElementById("summary");
const metaSummary = document.getElementById("meta-summary");
const hexOutput = document.getElementById("hex");
const downloadButton = document.getElementById("download");
const copyHexButton = document.getElementById("copy-hex");
const notes = document.getElementById("notes");
const modeTemplate = document.getElementById("mode-template");
const defaultRow = document.querySelector(".mode-row[data-default='true']");
const autoHints = {
  deepColor: {
    mark: document.querySelector("[data-auto='deep-color']"),
    note: document.querySelector("[data-auto-note='deep-color']"),
  },
  dsc: {
    mark: document.querySelector("[data-auto='dsc']"),
    note: document.querySelector("[data-auto-note='dsc']"),
  },
};
const optionalHints = {
  dsc: {
    mark: document.querySelector("[data-note='dsc']"),
    note: document.querySelector("[data-note-body='dsc']"),
  },
  vrr: {
    mark: document.querySelector("[data-note='vrr']"),
    note: document.querySelector("[data-note-body='vrr']"),
  },
};

const { generateEdid, formatHex } = window.EdidCore || {};

let lastEdid = null;
let lastHex = "";
let dscUserOverride = false;
let deepColorUserOverride = false;
let deepColorAuto = false;
let dscAuto = false;
const STORAGE_KEY = "edid-generator-state-v1";
const RESOLUTION_PRESETS = [
  { label: "8K", width: 7680, height: 4320 },
  { label: "4K", width: 3840, height: 2160 },
  { label: "1440p", width: 2560, height: 1440 },
  { label: "1080p", width: 1920, height: 1080 },
  { label: "720p", width: 1280, height: 720 },
];

function formatMode(mode) {
  return `${mode.width}x${mode.height}@${mode.refresh}Hz`;
}

function formatModes(modes, separator = ", ") {
  if (!modes || !modes.length) return "None";
  return modes.map(formatMode).join(separator);
}

function formatKHzToMHz(khz) {
  if (!Number.isFinite(khz)) return "Unknown";
  const mhz = khz / 1000;
  const rounded = mhz >= 100 ? Math.round(mhz) : Math.round(mhz * 10) / 10;
  return `${rounded} MHz`;
}

function formatMHz(mhz) {
  if (!Number.isFinite(mhz)) return "Unknown";
  const rounded = mhz >= 100 ? Math.round(mhz) : Math.round(mhz * 10) / 10;
  return `${rounded} MHz`;
}

function renderPills(container, items, status = false) {
  container.innerHTML = "";
  if (!items.length) {
    const pill = document.createElement("div");
    pill.className = `pill${status ? " status" : ""}`;
    pill.textContent = "No output yet.";
    container.appendChild(pill);
    return;
  }
  for (const item of items) {
    const pill = document.createElement("div");
    pill.className = `pill${item.status ? " status" : ""}`;
    const label = document.createElement("span");
    label.className = "pill-label";
    label.textContent = item.label;
    const value = document.createElement("span");
    value.className = "pill-value";
    value.textContent = item.value;
    pill.append(label, value);
    container.appendChild(pill);
  }
}

function renderStatus(message) {
  renderPills(summary, [{ label: "Status", value: message, status: true }], true);
  if (metaSummary) metaSummary.innerHTML = "";
}

function readRowValues(row) {
  if (!row) return null;
  const width = row.querySelector("[data-field='width']");
  const height = row.querySelector("[data-field='height']");
  const refresh = row.querySelector("[data-field='refresh']");
  return {
    width: width ? width.value : "",
    height: height ? height.value : "",
    refresh: refresh ? refresh.value : "",
  };
}

function applyRowValues(row, values) {
  if (!row || !values || typeof values !== "object") return;
  const width = row.querySelector("[data-field='width']");
  const height = row.querySelector("[data-field='height']");
  const refresh = row.querySelector("[data-field='refresh']");
  if (width && values.width !== undefined && values.width !== null && values.width !== "") {
    width.value = values.width;
  }
  if (height && values.height !== undefined && values.height !== null && values.height !== "") {
    height.value = values.height;
  }
  if (refresh && values.refresh !== undefined && values.refresh !== null && values.refresh !== "") {
    refresh.value = values.refresh;
  }
}

function hasAnyValue(values) {
  if (!values || typeof values !== "object") return false;
  return ["width", "height", "refresh"].some((key) => {
    const value = values[key];
    return value !== undefined && value !== null && String(value).trim() !== "";
  });
}

function saveState() {
  if (!window.localStorage) return;
  const state = {
    version: 1,
    defaultMode: readRowValues(defaultRow),
    extraModes: [...extraModes.querySelectorAll(".mode-row")]
      .map(readRowValues)
      .filter(hasAnyValue),
    options: {
      audio: audioToggle.checked,
      hdr: hdrToggle.checked,
      deepColor: deepColorToggle.checked,
      dsc: dscToggle ? dscToggle.checked : false,
      vrr: vrrToggle.checked,
      listedModesOnly: listedModesToggle ? listedModesToggle.checked : false,
    },
    deepColorUserOverride,
    dscUserOverride,
  };
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (err) {
    console.warn("Local storage error", err);
  }
}

function loadState() {
  if (!window.localStorage) return;
  let parsed = null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    parsed = JSON.parse(raw);
  } catch (err) {
    console.warn("Local storage error", err);
    return;
  }
  if (!parsed || typeof parsed !== "object") return;

  const options = parsed.options || {};
  if (typeof options.audio === "boolean") audioToggle.checked = options.audio;
  if (typeof options.hdr === "boolean") hdrToggle.checked = options.hdr;
  if (typeof options.deepColor === "boolean") deepColorToggle.checked = options.deepColor;
  if (typeof options.dsc === "boolean" && dscToggle) dscToggle.checked = options.dsc;
  if (typeof options.vrr === "boolean") vrrToggle.checked = options.vrr;
  if (typeof options.listedModesOnly === "boolean" && listedModesToggle) {
    listedModesToggle.checked = options.listedModesOnly;
  }

  applyRowValues(defaultRow, parsed.defaultMode);
  if (defaultRow) wirePresetRow(defaultRow);

  extraModes.innerHTML = "";
  if (Array.isArray(parsed.extraModes)) {
    for (const values of parsed.extraModes) {
      if (!hasAnyValue(values)) continue;
      addModeRow(values);
    }
  }

  if (typeof parsed.deepColorUserOverride === "boolean") {
    deepColorUserOverride = parsed.deepColorUserOverride;
  } else {
    deepColorUserOverride = Boolean(
      hdrToggle.checked && deepColorToggle && !deepColorToggle.checked
    );
  }
  if (typeof parsed.dscUserOverride === "boolean") {
    dscUserOverride = parsed.dscUserOverride;
  }
}

function setAutoHint(key, enabled) {
  const hint = autoHints[key];
  if (!hint || !hint.mark || !hint.note) return;
  hint.mark.hidden = !enabled;
  hint.note.hidden = !enabled;
}

function setOptionalHint(key, enabled) {
  const hint = optionalHints[key];
  if (!hint || !hint.mark || !hint.note) return;
  hint.mark.hidden = !enabled;
  hint.note.hidden = !enabled;
}

function hasResolutionRefreshVariants(modes) {
  const byResolution = new Map();
  for (const mode of modes) {
    const key = `${mode.width}x${mode.height}`;
    if (!byResolution.has(key)) byResolution.set(key, new Set());
    byResolution.get(key).add(mode.refresh);
  }
  for (const refreshes of byResolution.values()) {
    if (refreshes.size > 1) return true;
  }
  return false;
}

function wirePresetRow(row) {
  const presetSelect = row.querySelector("[data-field='preset']");
  const widthInput = row.querySelector("[data-field='width']");
  const heightInput = row.querySelector("[data-field='height']");
  if (!presetSelect || !widthInput || !heightInput) return;

  const syncPresetSelect = () => {
    const width = Number(widthInput.value);
    const height = Number(heightInput.value);
    const match = RESOLUTION_PRESETS.find(
      (preset) => preset.width === width && preset.height === height
    );
    presetSelect.value = match ? `${match.width}x${match.height}` : "";
  };

  if (row.dataset.presetWired === "true") {
    syncPresetSelect();
    return;
  }

  row.dataset.presetWired = "true";
  presetSelect.addEventListener("change", () => {
    if (!presetSelect.value) return;
    const [width, height] = presetSelect.value.split("x").map(Number);
    if (!Number.isFinite(width) || !Number.isFinite(height)) return;
    widthInput.value = width;
    heightInput.value = height;
    syncPresetSelect();
    handleModeInput();
  });

  widthInput.addEventListener("input", syncPresetSelect);
  heightInput.addEventListener("input", syncPresetSelect);
  syncPresetSelect();
}

function addModeRow(values = {}) {
  const fragment = modeTemplate.content.cloneNode(true);
  const row = fragment.querySelector(".mode-row");
  if (values.width) row.querySelector("[data-field='width']").value = values.width;
  if (values.height) row.querySelector("[data-field='height']").value = values.height;
  if (values.refresh) row.querySelector("[data-field='refresh']").value = values.refresh;
  row.querySelector("[data-remove]").addEventListener("click", () => {
    row.remove();
    handleModeInput();
  });
  wirePresetRow(row);
  extraModes.appendChild(fragment);
}

function readModeRow(row) {
  const width = Number(row.querySelector("[data-field='width']").value);
  const height = Number(row.querySelector("[data-field='height']").value);
  const refresh = Number(row.querySelector("[data-field='refresh']").value);
  if (!Number.isFinite(width) || !Number.isFinite(height) || !Number.isFinite(refresh)) {
    return null;
  }
  if (width <= 0 || height <= 0 || refresh <= 0) {
    return null;
  }
  return {
    width: Math.round(width),
    height: Math.round(height),
    refresh: Math.round(refresh),
  };
}

function readModesFromForm() {
  const defaultRow = document.querySelector(".mode-row[data-default='true']");
  const defaultMode = readModeRow(defaultRow);
  const extra = [...extraModes.querySelectorAll(".mode-row")]
    .map(readModeRow)
    .filter(Boolean);

  if (!defaultMode) {
    return { defaultMode: null, extraModes: [] };
  }

  return { defaultMode, extraModes: extra };
}

function normalizeModes(defaultMode, extraModes) {
  const seen = new Set();
  const warnings = [];

  const unique = [];
  const add = (mode) => {
    const key = `${mode.width}x${mode.height}@${mode.refresh}`;
    if (seen.has(key)) {
      warnings.push(`Duplicate mode removed: ${key}.`);
      return;
    }
    seen.add(key);
    unique.push(mode);
  };

  add(defaultMode);
  extraModes.forEach(add);

  return { modes: unique, warnings };
}

function renderOutput(result) {
  const features = result.features || {};
  const metadata = result.metadata || {};
  const displayId = metadata.displayId;
  const maxTmdsMhz = metadata.maxTmdsHfMhz ?? metadata.maxTmdsHdmiMhz;
  const frlRate = metadata.frlRate;
  const dscLabel = metadata.dscEnabled
    ? "Auto (On)"
    : metadata.dscRequired
      ? "Off (4:2:0)"
      : "Off";
  const summaryItems = [
    {
      label: "Preferred timing",
      value: result.preferredMode ? formatMode(result.preferredMode) : "Unknown",
    },
    {
      label: "CTA modes",
      value: formatModes(result.advertisedModes, " "),
    },
    {
      label: "DisplayID modes",
      value: displayId && displayId.modes.length
        ? formatModes(displayId.modes, " ")
        : "Not needed",
    },
    {
      label: "HDMI link",
      value: metadata.hdmiVersion || "Unknown",
    },
    {
      label: "Max TMDS",
      value: formatMHz(maxTmdsMhz),
    },
    {
      label: "Max dot clock",
      value: formatKHzToMHz(metadata.maxPixelClockKHz),
    },
    {
      label: "FRL",
      value: frlRate || "Not advertised",
    },
    {
      label: "Audio",
      value: features.audio ? "On" : "Off",
    },
    {
      label: "HDR10",
      value: features.hdr ? "On" : "Off",
    },
    {
      label: "10-bit color",
      value: features.deepColor ? "On" : "Off",
    },
    {
      label: "DSC",
      value: dscLabel,
    },
    {
      label: "VRR",
      value: metadata.vrrRange
        ? `${metadata.vrrRange.min}-${metadata.vrrRange.max} Hz`
        : "Off",
    },
    {
      label: "Inferred modes",
      value: features.listedModesOnly ? "Reduced (no GTF)" : "Expanded (GTF)",
    },
  ];
  const versionMajor = result.bytes && result.bytes.length > 19 ? result.bytes[18] : null;
  const versionMinor = result.bytes && result.bytes.length > 19 ? result.bytes[19] : null;
  const edidVersion = Number.isFinite(versionMajor) && Number.isFinite(versionMinor)
    ? `${versionMajor}.${versionMinor}`
    : "Unknown";
  const extensionCount = result.bytes && result.bytes.length > 126 ? result.bytes[126] : 0;
  let hasCta = false;
  if (extensionCount && result.bytes) {
    for (let i = 1; i <= extensionCount; i += 1) {
      const offset = i * 128;
      if (offset < result.bytes.length && result.bytes[offset] === 0x02) {
        hasCta = true;
        break;
      }
    }
  }
  const metaItems = [
    { label: "EDID", value: edidVersion },
    { label: "CTA-861", value: hasCta ? "On" : "Off" },
    { label: "DisplayID", value: displayId ? "On" : "Off" },
    { label: "Timing", value: "CVT (auto RB)" },
  ];
  renderPills(metaSummary, metaItems);
  renderPills(summary, summaryItems);
  hexOutput.textContent = formatHex(result.bytes);
  notes.textContent = result.warnings.length ? result.warnings.join("\n") : "";
  downloadButton.disabled = false;
  copyHexButton.disabled = false;
  lastEdid = result.bytes;
  lastHex = hexOutput.textContent;
}

function handleGenerate() {
  if (!generateEdid || !formatHex) {
    renderStatus("EDID engine not loaded.");
    return;
  }

  const { defaultMode, extraModes } = readModesFromForm();
  if (!defaultMode) {
    renderStatus("Enter a valid default mode.");
    hexOutput.textContent = "";
    notes.textContent = "";
    downloadButton.disabled = true;
    copyHexButton.disabled = true;
    setOptionalHint("dsc", false);
    setOptionalHint("vrr", false);
    saveState();
    return;
  }

  const normalized = normalizeModes(defaultMode, extraModes);
  const settings = {
    defaultMode,
    modes: normalized.modes,
    audio: audioToggle.checked,
    hdr: hdrToggle.checked,
    deepColor: deepColorToggle.checked,
    dsc: dscToggle ? dscToggle.checked : false,
    vrr: vrrToggle.checked,
    listedModesOnly: listedModesToggle ? listedModesToggle.checked : false,
  };
  let result = generateEdid(settings);

  if (result.metadata && !result.metadata.dscRequired) {
    dscUserOverride = false;
    dscAuto = false;
  }
  if (dscToggle && !dscUserOverride && result.metadata) {
    const shouldEnableDsc = Boolean(result.metadata.dscRequired);
    if (dscToggle.checked !== shouldEnableDsc) {
      dscToggle.checked = shouldEnableDsc;
      settings.dsc = shouldEnableDsc;
      result = generateEdid(settings);
    }
    dscAuto = shouldEnableDsc;
  }

  result.warnings.unshift(...normalized.warnings);
  renderOutput(result);
  setAutoHint("dsc", dscAuto);
  setOptionalHint(
    "dsc",
    Boolean(dscToggle && dscToggle.checked && result.metadata && !result.metadata.dscRequired)
  );
  const vrrVariants = hasResolutionRefreshVariants(normalized.modes);
  setOptionalHint("vrr", Boolean(vrrToggle.checked && !vrrVariants));
  saveState();
}

addModeButton.addEventListener("click", () => {
  addModeRow();
  handleModeInput();
});

copyHexButton.addEventListener("click", async () => {
  if (!lastHex) return;
  try {
    await navigator.clipboard.writeText(lastHex);
    copyHexButton.textContent = "Copied";
    setTimeout(() => {
      copyHexButton.textContent = "Copy hex";
    }, 1200);
  } catch (err) {
    console.warn("Clipboard error", err);
  }
});

downloadButton.addEventListener("click", () => {
  if (!lastEdid) return;
  const blob = new Blob([lastEdid], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "edid.bin";
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
});

function syncDeepColorToggle() {
  if (!hdrToggle.checked) {
    deepColorUserOverride = false;
    deepColorAuto = false;
    setAutoHint("deep-color", false);
    return;
  }
  deepColorAuto = !deepColorUserOverride;
  if (deepColorAuto && !deepColorToggle.checked) {
    deepColorToggle.checked = true;
  }
  setAutoHint("deep-color", deepColorAuto);
}

function handleModeInput() {
  handleGenerate();
}

function handleOptionChange() {
  handleGenerate();
}

hdrToggle.addEventListener("change", () => {
  syncDeepColorToggle();
  handleOptionChange();
});
audioToggle.addEventListener("change", handleOptionChange);
deepColorToggle.addEventListener("change", () => {
  deepColorUserOverride = hdrToggle.checked;
  deepColorAuto = false;
  setAutoHint("deep-color", false);
  handleOptionChange();
});
if (dscToggle) {
  dscToggle.addEventListener("change", () => {
    dscUserOverride = true;
    dscAuto = false;
    setAutoHint("dsc", false);
    setOptionalHint("dsc", false);
    handleOptionChange();
  });
}
vrrToggle.addEventListener("change", handleOptionChange);
if (listedModesToggle) {
  listedModesToggle.addEventListener("change", handleOptionChange);
}
if (defaultRow) {
  defaultRow.addEventListener("input", handleModeInput);
  wirePresetRow(defaultRow);
}
extraModes.addEventListener("input", handleModeInput);
loadState();
syncDeepColorToggle();

handleGenerate();
