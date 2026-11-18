const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const appSource = fs.readFileSync(path.join(__dirname, "../assets/js/app.js"), "utf8");
const STORAGE_KEY = "edid-generator-state-v1";
const clone = (value) => JSON.parse(JSON.stringify(value));
const settle = () => new Promise((resolve) => setImmediate(resolve));
const optionIds = {
  audio: "audio-toggle",
  hdr: "hdr-toggle",
  deepColor: "deep-color-toggle",
  dsc: "dsc-toggle",
  vrr: "vrr-toggle",
  listedModesOnly: "listed-modes-toggle",
};
const oldState = {
  version: 1,
  defaultMode: { width: "7680", height: "4320", refresh: "60" },
  extraModes: [
    { width: "1920", height: "1080", refresh: "30" },
    { width: "1280", height: "720", refresh: "60" },
  ],
  options: { audio: true, hdr: true, deepColor: false, dsc: false, vrr: false, listedModesOnly: false },
  deepColorUserOverride: false,
  dscUserOverride: false,
};
const importedMode = { width: 7680, height: 4320, refresh: 120 };
const importedSettings = {
  defaultMode: importedMode,
  modes: [importedMode, { width: 2560, height: 1440, refresh: 120 }, { width: 2560, height: 1440, refresh: 60 }],
  audio: false,
  hdr: true,
  deepColor: false,
  dsc: false,
  vrr: true,
  listedModesOnly: true,
};
const secondMode = { width: 1920, height: 1080, refresh: 75 };
const secondSettings = {
  defaultMode: secondMode,
  modes: [secondMode],
  audio: true,
  hdr: false,
  deepColor: true,
  dsc: true,
  vrr: false,
  listedModesOnly: false,
};

// Only the DOM surface app.js uses: event listeners, text, mode rows and controls.
// Document events stand in for bubbled browser drag events; no layout or HTML parser.
class Events {
  constructor() {
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }

  fire(type, properties = {}) {
    const event = {
      type,
      target: this,
      defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; },
      ...properties,
    };
    for (const listener of this.listeners.get(type) || []) listener(event);
    return event;
  }
}

class Element extends Events {
  constructor(tagName = "div") {
    super();
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.selectors = new Map();
    this.dataset = {};
    this.hidden = false;
    this.open = false;
    this.checked = false;
    this.disabled = false;
    this.value = "";
    this.textContent = "";
    const classes = new Set();
    this.classList = {
      contains: (name) => classes.has(name),
      toggle(name, enabled) {
        if (enabled) classes.add(name);
        else classes.delete(name);
      },
    };
  }

  set value(value) { this._value = String(value); }
  get value() { return this._value; }
  set textContent(value) {
    for (const child of this.children) child.parentElement = null;
    this.children = [];
    this._text = String(value);
  }
  get textContent() { return this._text + this.children.map((child) => child.textContent).join(""); }
  set innerHTML(value) {
    // Clearing containers is supported; status messages must never be parsed as HTML.
    assert.equal(value, "", "Only container-clearing innerHTML is allowed");
    this.textContent = "";
  }

  append(...children) {
    for (const child of children) this.appendChild(child);
  }

  appendChild(child) {
    if (child.isFragment) {
      for (const node of [...child.children]) this.appendChild(node);
    } else {
      child.remove();
      child.parentElement = this;
      this.children.push(child);
    }
    return child;
  }

  remove() {
    if (!this.parentElement) return;
    const siblings = this.parentElement.children;
    siblings.splice(siblings.indexOf(this), 1);
    this.parentElement = null;
  }

  click() {
    this.fire("click");
  }

  querySelector(selector) {
    return this.selectors.get(selector) || this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector) {
    assert.equal(selector, ".mode-row", `Unexpected selector: ${selector}`);
    return this.children.filter((child) => child.className === "mode-row");
  }
}

class NumberInput extends Element {
  constructor(min, max) {
    super();
    this.min = String(min);
    this.max = String(max);
    this.step = ""; // Number inputs default to an integer step when HTML omits it.
    this.required = false;
  }

  set value(value) {
    const text = String(value);
    // Programmatic number-input assignments sanitize invalid numbers to an empty value.
    this._value = /^-?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)
      && Number.isFinite(Number(text)) ? text : "";
  }
  get value() { return this._value; }

  get validity() {
    const value = Number(this.value);
    const hasValue = this.value !== "";
    const step = Number(this.step) > 0 ? Number(this.step) : 1;
    const flags = {
      valueMissing: this.required && !hasValue,
      rangeUnderflow: hasValue && this.min !== "" && value < Number(this.min),
      rangeOverflow: hasValue && this.max !== "" && value > Number(this.max),
      stepMismatch: hasValue && this.step !== "any"
        && !Number.isInteger((value - Number(this.min || 0)) / step),
    };
    return { ...flags, valid: !Object.values(flags).some(Boolean) };
  }

  checkValidity() {
    return this.validity.valid;
  }
}

function makeRow(values = { width: 2560, height: 1440, refresh: 60 }) {
  const row = new Element();
  row.className = "mode-row";
  // Match the number-input constraints in index.html, including its implicit step=1.
  const limits = { width: [320, 7680], height: [200, 4320], refresh: [24, 240] };
  for (const field of ["width", "height", "refresh", "preset"]) {
    const input = limits[field] ? new NumberInput(...limits[field]) : new Element();
    input.value = values[field] ?? "";
    row.selectors.set(`[data-field='${field}']`, input);
    row.append(input);
  }
  const remove = new Element();
  row.selectors.set("[data-remove]", remove);
  row.append(remove);
  return row;
}

function createApp({ storedState = oldState, warnings = [], storageFailure = null } = {}) {
  const nodes = Object.fromEntries([
    "add-mode", "extra-modes", ...Object.values(optionIds), "summary", "meta-summary", "hex",
    "download", "copy-hex", "notes", "drop-overlay", "import-status", "mode-template",
  ].map((id) => [id, new Element()]));
  nodes["audio-toggle"].checked = true;
  for (const id of ["drop-overlay", "import-status"]) nodes[id].hidden = true;
  for (const id of ["download", "copy-hex"]) nodes[id].disabled = true;
  const defaultRow = makeRow({ width: 3840, height: 2160, refresh: 60 });
  const selectors = new Map([[".mode-row[data-default='true']", defaultRow]]);
  for (const selector of [
    "[data-auto='deep-color']", "[data-auto-note='deep-color']", "[data-auto='dsc']", "[data-auto-note='dsc']",
    "[data-note='dsc']", "[data-note-body='dsc']", "[data-note='vrr']", "[data-note-body='vrr']",
  ]) {
    const hint = new Element();
    hint.hidden = true;
    selectors.set(selector, hint);
  }
  nodes["mode-template"].content = {
    cloneNode() {
      const fragment = new Element();
      fragment.isFragment = true;
      fragment.append(makeRow());
      return fragment;
    },
  };
  const document = Object.assign(new Events(), {
    body: new Element(),
    hidden: false,
    getElementById: (id) => nodes[id] || null,
    querySelector: (selector) => selectors.get(selector) || null,
    createElement: (tagName) => new Element(tagName),
  });
  const storage = new Map([[STORAGE_KEY, JSON.stringify(storedState)]]);
  const writes = [];
  const generated = [];
  const parsed = [];
  const copied = [];
  const downloads = [];
  const loggedWarnings = [];
  const storageCalls = [];
  const storageError = Object.assign(new Error("Storage access denied."), { name: "SecurityError" });
  const localStorage = {
    getItem(key) {
      storageCalls.push("getItem");
      if (storageFailure === "getItem") throw storageError;
      return storage.get(key) ?? null;
    },
    setItem(key, value) {
      storageCalls.push("setItem");
      if (storageFailure === "setItem") throw storageError;
      storage.set(key, value);
      writes.push([key, value]);
    },
  };
  const window = Object.assign(new Events(), {
    EdidCore: {
      generateEdid(settings) {
        generated.push(clone(settings));
        // A deterministic output plus a minimal bandwidth-dependent auto-DSC signal.
        const bytes = new Uint8Array(128);
        bytes[18] = 1;
        bytes[19] = 4;
        bytes[20] = generated.length;
        const dscRequired = settings.modes.some((mode) => mode.width >= 7680);
        return {
          bytes,
          preferredMode: settings.defaultMode,
          advertisedModes: settings.modes,
          features: settings,
          metadata: { dscRequired, dscEnabled: settings.dsc, hdmiVersion: "2.1" },
          warnings: ["Generator warning."],
        };
      },
      formatHex: (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(" "),
    },
    EdidImport: {
      parseEdid(bytes) {
        parsed.push(Array.from(bytes));
        const settings = { 1: importedSettings, 2: secondSettings }[bytes[0]];
        if (!settings) throw new Error("Invalid EDID header.");
        return { settings: clone(settings), warnings: [...warnings] };
      },
    },
  });
  Object.defineProperty(window, "localStorage", {
    get() {
      storageCalls.push("getter");
      if (storageFailure === "getter") throw storageError;
      return localStorage;
    },
  });
  // Execute the entire production script, not extracted/reimplemented handlers.
  vm.runInNewContext(appSource, {
    document,
    window,
    console: { ...console, warn: (...args) => loggedWarnings.push(args) },
    navigator: { clipboard: { async writeText(text) { copied.push(text); } } },
    Blob,
    URL: {
      createObjectURL(blob) { downloads.push(blob); return `blob:test-${downloads.length}`; },
      revokeObjectURL() {},
    },
    setTimeout: (callback) => callback(),
  }, { filename: "assets/js/app.js" });

  const rowValues = (row) => Object.fromEntries(["width", "height", "refresh"].map((field) => [
    field, Number(row.querySelector(`[data-field='${field}']`).value),
  ]));
  const formSettings = () => ({
    defaultMode: rowValues(defaultRow),
    modes: [rowValues(defaultRow), ...nodes["extra-modes"].querySelectorAll(".mode-row").map(rowValues)],
    ...Object.fromEntries(Object.entries(optionIds).map(([key, id]) => [key, nodes[id].checked])),
  });
  return {
    document, window, nodes, selectors, defaultRow, generated, parsed, writes,
    copied, downloads, loggedWarnings, storageCalls,
    setStorageFailure(failure) { storageFailure = failure; },
    formSettings,
    saved: () => JSON.parse(storage.get(STORAGE_KEY)),
    drag(type, { files = [], types = ["Files"], target = document.body } = {}) {
      return document.fire(type, { target, dataTransfer: { files, types, dropEffect: "none" } });
    },
    snapshot() {
      return {
        form: formSettings(),
        preset: defaultRow.querySelector("[data-field='preset']").value,
        hints: [...selectors].filter(([key]) => key !== ".mode-row[data-default='true']")
          .map(([key, node]) => [key, node.hidden]),
        output: ["summary", "meta-summary", "hex", "notes"].map((id) => nodes[id].textContent),
        disabled: [nodes.download.disabled, nodes["copy-hex"].disabled],
        storage: [...storage],
        writes: writes.length,
        generations: generated.length,
      };
    },
  };
}

function fileBytes(marker = 1, size = 128) {
  const bytes = new Uint8Array(size);
  bytes[0] = marker;
  return bytes.buffer;
}

// File and FileList facades only need name/size/arrayBuffer and length/indexing.
function file({ name = "display.bin", size = 128, marker = 1, read } = {}) {
  return { name, size, arrayBuffer: read || (async () => fileBytes(marker, size)) };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function assertOverlay(app, visible) {
  assert.equal(app.nodes["drop-overlay"].hidden, !visible);
  assert.equal(app.document.body.classList.contains("file-drag"), visible);
}

function assertAutoHint(app, key, enabled) {
  for (const selector of [`[data-auto='${key}']`, `[data-auto-note='${key}']`]) {
    assert.equal(app.selectors.get(selector).hidden, !enabled, selector);
  }
}

const invalidDrops = [
  { name: "no files", files: () => [], error: /one.*file/i },
  { name: "multiple files", files: () => [file(), file({ name: "other.bin" })], error: /one.*file/i },
  { name: "empty file", files: () => [file({ size: 0 })], error: /128-byte/i },
  { name: "short file", files: () => [file({ size: 127 })], error: /128-byte/i },
  { name: "partial block", files: () => [file({ size: 129 })], error: /128-byte/i },
  { name: "oversize file", files: () => [file({ size: 32768 + 128 })], error: /32 KiB/i },
  { name: "invalid EDID", files: () => [file({ marker: 0 })], error: /Invalid EDID header/ },
  {
    name: "unreadable file",
    files: () => [file({ read: async () => { throw new Error("Permission denied."); } })],
    error: /Permission denied/,
  },
];

test("invalid default and additional mode edits clear output until the row is fixed", async (t) => {
  const invalidValues = [
    ["width", ""], ["width", "not a number"], ["width", "Infinity"], ["width", "0x500"],
    ["width", 0], ["width", -1], ["width", 1], ["width", 319], ["width", 7681], ["width", 1920.5],
    ["height", 199], ["height", 4321], ["height", 1080.5],
    ["refresh", 23], ["refresh", 241], ["refresh", 59.94],
  ];
  for (const kind of ["default", "additional"]) {
    for (const [field, value] of invalidValues) {
      await t.test(`${kind} ${field}=${JSON.stringify(value)}`, async () => {
        const app = createApp();
        const row = kind === "default" ? app.defaultRow : app.nodes["extra-modes"].children[1];
        const eventTarget = kind === "default" ? row : app.nodes["extra-modes"];
        const input = row.querySelector(`[data-field='${field}']`);
        const originalValue = input.value;
        const originalHex = app.nodes.hex.textContent;
        const generations = app.generated.length;
        input.value = value;
        eventTarget.fire("input");

        assert.equal(app.generated.length, generations, "An invalid row must not be silently omitted");
        assert.match(app.nodes.summary.textContent,
          kind === "default" ? /valid default mode/ : /valid additional mode \(row 2\)/);
        assert.match(app.nodes.summary.textContent, /whole numbers.*limits/);
        for (const id of ["hex", "notes", "meta-summary"]) assert.equal(app.nodes[id].textContent, "");
        assert.equal(app.nodes.download.disabled, true);
        assert.equal(app.nodes["copy-hex"].disabled, true);
        // Invoke handlers directly too: disabled buttons must not retain stale downloadable data.
        app.nodes.download.fire("click");
        app.nodes["copy-hex"].fire("click");
        await settle();
        assert.equal(app.downloads.length, 0);
        assert.equal(app.copied.length, 0);
        app.nodes["audio-toggle"].fire("change");
        assert.equal(app.generated.length, generations);
        assert.equal(app.nodes.download.disabled, true);

        input.value = originalValue;
        eventTarget.fire("input");
        assert.ok(app.generated.length > generations);
        assert.deepEqual(app.generated.at(-1), app.formSettings());
        assert.notEqual(app.nodes.hex.textContent, originalHex);
        assert.equal(app.nodes.download.disabled, false);
        assert.equal(app.nodes["copy-hex"].disabled, false);
        app.nodes.download.fire("click");
        app.nodes["copy-hex"].fire("click");
        await settle();
        assert.deepEqual(app.copied, [app.nodes.hex.textContent]);
        assert.equal(app.downloads.length, 1);
        const downloaded = new Uint8Array(await app.downloads[0].arrayBuffer());
        assert.equal(downloaded[20], app.generated.length, "Recovery downloads the newly generated output");
      });
    }
  }
});

test("mode validation honors native input constraints and accepts inclusive limits", () => {
  const app = createApp({ storedState: null });
  const width = app.defaultRow.querySelector("[data-field='width']");
  width.step = "2";
  width.value = "1921";
  app.defaultRow.fire("input");
  assert.equal(app.nodes.download.disabled, true);
  assert.match(app.nodes.summary.textContent, /valid default mode/);
  width.value = "1922";
  app.defaultRow.fire("input");
  assert.equal(app.nodes.download.disabled, false);
  assert.equal(app.generated.at(-1).defaultMode.width, 1922);

  const minimum = { width: 320, height: 200, refresh: 24 };
  const maximum = { width: 7680, height: 4320, refresh: 240 };
  for (const [field, value] of Object.entries(minimum)) {
    app.defaultRow.querySelector(`[data-field='${field}']`).value = value;
  }
  app.defaultRow.fire("input");
  app.nodes["add-mode"].fire("click");
  const extraRow = app.nodes["extra-modes"].children[0];
  for (const [field, value] of Object.entries(maximum)) {
    extraRow.querySelector(`[data-field='${field}']`).value = value;
  }
  app.nodes["extra-modes"].fire("input");
  assert.equal(app.nodes.download.disabled, false);
  assert.equal(app.nodes["copy-hex"].disabled, false);
  assert.deepEqual(app.generated.at(-1).modes, [minimum, maximum]);
});

test("storage getter, read and write denials never prevent initial generation or editing", async (t) => {
  for (const storageFailure of ["getter", "getItem", "setItem"]) {
    await t.test(storageFailure, () => {
      const app = createApp({ storageFailure });
      assert.ok(app.storageCalls.includes(storageFailure));
      assert.ok(app.loggedWarnings.length > 0);
      assert.ok(app.generated.length > 0);
      assert.ok(app.nodes.hex.textContent);
      assert.equal(app.nodes.download.disabled, false);
      assert.equal(app.nodes["copy-hex"].disabled, false);
      const generations = app.generated.length;
      const originalHex = app.nodes.hex.textContent;
      for (const [field, value] of Object.entries(secondMode)) {
        app.defaultRow.querySelector(`[data-field='${field}']`).value = value;
      }
      app.defaultRow.fire("input");
      assert.ok(app.generated.length > generations);
      assert.deepEqual(app.generated.at(-1).defaultMode, secondMode);
      assert.notEqual(app.nodes.hex.textContent, originalHex);
      assert.equal(app.nodes.download.disabled, false);
      assert.equal(app.nodes["copy-hex"].disabled, false);
      assert.ok(app.loggedWarnings.every(([message, error]) =>
        message === "Local storage error" && error.name === "SecurityError"));
      if (storageFailure === "getItem") assert.ok(app.writes.length > 0);
      else assert.equal(app.writes.length, 0);
    });
  }
});

test("storage access revoked after loading does not interrupt later edits", async (t) => {
  for (const failure of ["getter", "setItem"]) {
    await t.test(failure, () => {
      const app = createApp();
      const generations = app.generated.length;
      const writes = app.writes.length;
      app.setStorageFailure(failure);
      app.defaultRow.querySelector("[data-field='refresh']").value = "75";
      app.defaultRow.fire("input");
      assert.ok(app.generated.length > generations);
      assert.equal(app.generated.at(-1).defaultMode.refresh, 75);
      assert.equal(app.nodes.download.disabled, false);
      assert.equal(app.nodes["copy-hex"].disabled, false);
      assert.equal(app.writes.length, writes);
      assert.equal(app.loggedWarnings.at(-1)[1].name, "SecurityError");
    });
  }
});

test("HDR automatically enables deep color and shows both hints only while inferred", async (t) => {
  for (const manualChoice of [false, true]) {
    await t.test(`manual deep color ${manualChoice}`, () => {
      const app = createApp({ storedState: null });
      assertAutoHint(app, "deep-color", false);
      app.nodes["hdr-toggle"].checked = true;
      app.nodes["hdr-toggle"].fire("change");
      assert.equal(app.nodes["deep-color-toggle"].checked, true);
      assert.equal(app.generated.at(-1).deepColor, true);
      assertAutoHint(app, "deep-color", true);
      app.nodes["deep-color-toggle"].checked = manualChoice;
      app.nodes["deep-color-toggle"].fire("change");
      assert.equal(app.generated.at(-1).deepColor, manualChoice);
      assertAutoHint(app, "deep-color", false);
      app.nodes["audio-toggle"].fire("change");
      assertAutoHint(app, "deep-color", false);
      assertAutoHint(createApp({ storedState: app.saved() }), "deep-color", false);
    });
  }

  await t.test("turning HDR off hides inferred hints", () => {
    const app = createApp({ storedState: null });
    app.nodes["hdr-toggle"].checked = true;
    app.nodes["hdr-toggle"].fire("change");
    assertAutoHint(app, "deep-color", true);
    app.nodes["hdr-toggle"].checked = false;
    app.nodes["hdr-toggle"].fire("change");
    assertAutoHint(app, "deep-color", false);
    app.nodes["hdr-toggle"].checked = true;
    app.nodes["hdr-toggle"].fire("change");
    assertAutoHint(app, "deep-color", true);
  });
});

test("nested file drags stay visible until the last leave, and dragover advertises copying", () => {
  const app = createApp();
  assertOverlay(app, false);
  assert.equal(app.drag("dragenter").defaultPrevented, true);
  assert.equal(app.drag("dragenter", { target: app.defaultRow }).defaultPrevented, true);
  assertOverlay(app, true);
  const over = app.drag("dragover");
  assert.equal(over.defaultPrevented, true);
  assert.equal(over.dataTransfer.dropEffect, "copy");
  app.drag("dragleave", { target: app.defaultRow });
  assertOverlay(app, true);
  app.drag("dragleave");
  assertOverlay(app, false);
  // Browsers can deliver dragover without a preceding dragenter on this document.
  app.drag("dragover");
  assertOverlay(app, true);
  app.drag("dragleave");
  assertOverlay(app, false);
});

test("leaving/cancelling the browser clears the overlay and resets nested drag state", async (t) => {
  const cancellations = {
    dragend: (app) => app.document.fire("dragend"),
    Escape: (app) => app.document.fire("keydown", { key: "Escape" }),
    blur: (app) => app.window.fire("blur"),
    hidden: (app) => { app.document.hidden = true; app.document.fire("visibilitychange"); },
  };
  for (const [name, cancel] of Object.entries(cancellations)) {
    await t.test(name, () => {
      const app = createApp();
      const before = app.snapshot();
      app.drag("dragenter");
      app.drag("dragenter");
      app.document.fire("keydown", { key: "a" });
      assertOverlay(app, true);
      cancel(app);
      assertOverlay(app, false);
      app.document.hidden = false;
      app.drag("dragenter");
      app.drag("dragleave");
      assertOverlay(app, false);
      assert.deepEqual(app.snapshot(), before);
    });
  }
});

test("text/link drags and events without a data transfer are ignored", () => {
  const app = createApp();
  const before = app.snapshot();
  for (const types of [["text/plain"], ["text/uri-list", "text/plain"], ["text/html"], []]) {
    for (const type of ["dragenter", "dragover", "drop"]) {
      const event = app.drag(type, { types });
      assert.equal(event.defaultPrevented, false);
      assert.equal(event.dataTransfer.dropEffect, "none");
      assertOverlay(app, false);
    }
  }
  for (const type of ["dragenter", "dragover", "drop"]) {
    assert.equal(app.document.fire(type).defaultPrevented, false);
  }
  assert.deepEqual(app.snapshot(), before);
  assert.equal(app.parsed.length, 0);
  assert.equal(app.nodes["import-status"].hidden, true);
});

test("invalid drops prevent browser navigation but preserve form, generated output and storage", async (t) => {
  for (const scenario of invalidDrops) {
    await t.test(scenario.name, async () => {
      const app = createApp();
      const before = app.snapshot();
      app.drag("dragenter");
      const drop = app.drag("drop", { files: scenario.files(), types: ["Files", "application/octet-stream"] });
      assert.equal(drop.defaultPrevented, true);
      assertOverlay(app, false);
      await settle();
      assert.deepEqual(app.snapshot(), before);
      assert.equal(app.nodes["import-status"].hidden, false);
      assert.match(app.nodes["import-status"].textContent, scenario.error);
      assert.deepEqual(app.nodes["import-status"].children.map((node) => node.tagName), ["STRONG"]);
    });
  }
});

test("successful imports replace modes/options, override auto choices, regenerate and persist", async () => {
  const warnings = ["Unsupported capability omitted.", "<img src=x onerror=alert(1)> & exact timings differ."];
  const app = createApp({ warnings });
  assert.equal(app.nodes["deep-color-toggle"].checked, true);
  assert.equal(app.nodes["dsc-toggle"].checked, true);
  assertAutoHint(app, "deep-color", true);
  assertAutoHint(app, "dsc", true);
  const before = app.snapshot();
  app.drag("dragenter");
  const drop = app.drag("drop", { files: [file({ name: "<display>.bin" })] });
  assert.equal(drop.defaultPrevented, true);
  assertOverlay(app, false);
  await settle();
  assert.deepEqual(app.formSettings(), importedSettings);
  assert.deepEqual(app.generated.at(-1), importedSettings);
  assert.notEqual(app.nodes.hex.textContent, before.output[2]);
  assert.equal(app.nodes.download.disabled, false);
  assert.equal(app.nodes["copy-hex"].disabled, false);
  assert.equal(app.nodes.notes.textContent, "Generator warning.");
  assert.ok(app.writes.length > before.writes);
  assert.equal(app.defaultRow.querySelector("[data-field='preset']").value, "7680x4320");
  for (const key of ["deep-color", "dsc"]) assertAutoHint(app, key, false);
  const status = app.nodes["import-status"];
  assert.equal(status.hidden, false);
  assert.deepEqual(status.children.map((node) => node.tagName), ["DETAILS"]);
  const details = status.children[0];
  assert.equal(details.open, false, "Import warnings must initially be collapsed");
  assert.deepEqual(details.children.map((node) => node.tagName), ["SUMMARY", "DIV"]);
  const [heading, diagnostics] = details.children;
  assert.deepEqual(heading.children.map((node) => node.tagName), ["STRONG"]);
  assert.equal(heading.children[0].textContent, "Imported <display>.bin with warnings.");
  assert.equal(heading.children[0].children.length, 0, "The filename must remain literal text");
  assert.equal(diagnostics.textContent, warnings.join("\n"));
  assert.equal(diagnostics.children.length, 0, "Warnings must remain literal text");
  assert.deepEqual(app.saved().options, Object.fromEntries(Object.keys(optionIds).map((key) => [key, importedSettings[key]])));
  assert.deepEqual(app.saved().extraModes, importedSettings.modes.slice(1).map((mode) =>
    Object.fromEntries(Object.entries(mode).map(([key, value]) => [key, String(value)]))));

  // Imported explicit HDR-without-deep-color and DSC-off choices survive reload/regeneration.
  const reloaded = createApp({ storedState: app.saved() });
  assert.deepEqual(reloaded.formSettings(), importedSettings);
  assertAutoHint(reloaded, "deep-color", false);
  reloaded.nodes["audio-toggle"].fire("change");
  assert.deepEqual(reloaded.generated.at(-1), importedSettings);
  assertAutoHint(reloaded, "deep-color", false);

  // A second import removes all old alternates and can explicitly enable unnecessary DSC.
  app.drag("drop", { files: [file({ name: "second.bin", marker: 2, size: 32768 })] });
  await settle();
  assert.deepEqual(app.formSettings(), secondSettings);
  assert.deepEqual(app.generated.at(-1), secondSettings);
  assert.equal(app.nodes["extra-modes"].children.length, 0);
  assert.equal(app.parsed.at(-1).length, 32768, "The maximum allowed file size is accepted");
  assert.deepEqual(createApp({ storedState: app.saved() }).formSettings(), secondSettings);
});

test("successful imports without warnings show only a literal bold filename", async () => {
  const app = createApp();
  const name = "<img src=x onerror=alert(1)>.bin";
  app.drag("drop", { files: [file({ name })] });
  await settle();
  const status = app.nodes["import-status"];
  assert.equal(status.hidden, false);
  assert.deepEqual(status.children.map((node) => node.tagName), ["STRONG"]);
  assert.equal(status.children[0].textContent, `Imported ${name}.`);
  assert.equal(status.children[0].children.length, 0, "The filename must remain literal text");
});

test("out-of-order reads cannot replace a newer successful drop", async () => {
  const app = createApp();
  const oldRead = deferred();
  const newRead = deferred();
  app.drag("drop", { files: [file({ name: "old.bin", read: () => oldRead.promise })] });
  app.drag("drop", { files: [file({ name: "new.bin", read: () => newRead.promise })] });
  newRead.resolve(fileBytes(2));
  await settle();
  assert.deepEqual(app.formSettings(), secondSettings);
  const afterNew = app.snapshot();
  const status = app.nodes["import-status"].textContent;
  assert.match(status, /Imported new\.bin/);
  oldRead.resolve(fileBytes(1));
  await settle();
  assert.deepEqual(app.snapshot(), afterNew);
  assert.equal(app.nodes["import-status"].textContent, status);
});

test("the latest invalid drop also supersedes earlier pending reads", async (t) => {
  for (const scenario of invalidDrops) {
    await t.test(scenario.name, async () => {
      const app = createApp();
      const before = app.snapshot();
      const oldRead = deferred();
      app.drag("drop", { files: [file({ name: "old.bin", read: () => oldRead.promise })] });
      app.drag("drop", { files: scenario.files() });
      await settle();
      const status = app.nodes["import-status"].textContent;
      assert.match(status, scenario.error);
      oldRead.resolve(fileBytes(1));
      await settle();
      assert.deepEqual(app.snapshot(), before);
      assert.equal(app.nodes["import-status"].textContent, status);
    });
  }
});

test("an earlier read cannot commit while a newer, ultimately invalid file is still reading", async () => {
  const app = createApp();
  const before = app.snapshot();
  const oldRead = deferred();
  const latestRead = deferred();
  app.drag("drop", { files: [file({ name: "old.bin", read: () => oldRead.promise })] });
  app.drag("drop", { files: [file({ name: "invalid.bin", read: () => latestRead.promise })] });
  oldRead.resolve(fileBytes(1));
  await settle();
  assert.deepEqual(app.snapshot(), before);
  assert.equal(app.nodes["import-status"].hidden, true);
  latestRead.resolve(fileBytes(0));
  await settle();
  assert.deepEqual(app.snapshot(), before);
  assert.match(app.nodes["import-status"].textContent, /Could not import invalid\.bin: Invalid EDID header/);
});

test("a stale read failure does not overwrite a newer success or its warnings", async () => {
  const app = createApp({ warnings: ["New import warning."] });
  const oldRead = deferred();
  app.drag("drop", { files: [file({ name: "old.bin", read: () => oldRead.promise })] });
  app.drag("drop", { files: [file({ name: "new.bin", marker: 2 })] });
  await settle();
  assert.deepEqual(app.formSettings(), secondSettings);
  const afterNew = app.snapshot();
  const status = app.nodes["import-status"].textContent;
  assert.match(status, /Imported new\.bin/);
  assert.match(status, /New import warning/);
  oldRead.reject(new Error("Old read failed."));
  await settle();
  assert.deepEqual(app.snapshot(), afterNew);
  assert.equal(app.nodes["import-status"].textContent, status);
});
