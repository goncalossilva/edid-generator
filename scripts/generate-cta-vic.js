#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

function renderCtaVic(entries) {
  return "// Generated from data/cta-861-g-vic.json. Do not edit.\n"
    + "// Regenerate with: node scripts/generate-cta-vic.js\n"
    + `window.CTA_VIC = ${JSON.stringify(entries, null, 2)};\n`;
}

if (require.main === module) {
  const rootDir = path.resolve(__dirname, "..");
  const entries = JSON.parse(fs.readFileSync(path.join(rootDir, "data/cta-861-g-vic.json"), "utf8"));
  fs.writeFileSync(path.join(rootDir, "assets/js/cta-861-g-vic.js"), renderCtaVic(entries));
}

module.exports = { renderCtaVic };
