# EDID Generator

A minimal, web-based EDID generator focused on the essentials: choose a default mode, add extra modes, and toggle basic options like audio/HDR/VRR.

## Usage

Open `index.html` in a browser (or head to https://edid.build). Use the form to generate and download `edid.bin`. Done!

To start from an existing EDID, drag one binary EDID file onto the page. A valid file with supported modes replaces the configurator values; invalid files leave them unchanged. Files are processed locally in your browser. Hex text is not supported.

Import is a starting point, not a lossless edit: display identity, exact timings, link limits, and unsupported capabilities are not preserved. Refresh rates are rounded to whole Hz, unsupported modes are skipped with warnings, and output is regenerated using the current generator’s rules. Review the imported settings before using the new EDID.

## Development

### How it's built

- Static HTML/CSS/JS with no build step; generation lives in `assets/js/edid-core.js` and binary import in `assets/js/edid-import.js`.
- Outputs an EDID 1.3 base block for HDMI VSDB compatibility (the HDMI VSDB spec targets EDID 1.3).
- Timings are generated using CVT with automatic reduced blanking when appropriate.
- CTA-861 VIC mappings come from `data/cta-861-g-vic.json`.
- DisplayID blocks are emitted when modes cannot fit CTA DTD/VDB limits.

### Automatic behavior

- Always includes a CTA-861 extension so HDMI audio/HDR/VRR signaling works.
- Default mode becomes the base-block preferred DTD; CTA VICs are listed in the CTA Video Data Block when available.
- HDMI capability is inferred from the highest-bandwidth mode (TMDS vs FRL rate).
- HDR enables 10-bit color; DSC auto-enables only when required. If DSC is off for extreme modes, the generator assumes 4:2:0 and marks only those CTA VICs as Y420-capable.
- DisplayID blocks are added as needed; modes that cannot fit CTA, DisplayID, or the single block map’s capacity are dropped with warnings.
- VRR is opt-in; when enabled without multiple refresh rates per resolution, the UI notes that it won’t engage.
- "Reduce inferred modes" disables the range descriptor and GTF support to limit synthesized modes.

### Updating CTA mappings

Edit `data/cta-861-g-vic.json`, then regenerate the checked-in browser table:

```sh
node scripts/generate-cta-vic.js
```

The tests check that both tables stay in sync. Serving the website still requires no build step.

### Testing

Run the regression tests (Node.js 22+):

```sh
node --test tests/*.test.js
```

Run the full test suite, including generator validation (Podman/Docker required):

```sh
./tests/run-tests.sh
```

Validate a single EDID with `edid-decode` (uses Podman/Docker if needed):

```sh
./tests/check-edid.sh path/to/edid.bin
```

The suite runs inside a container and fails on any unexpected generator or edid-decode warnings. Regression tests also check decoded timing dimensions, sync polarities, and advertised link capabilities, not just binary conformity.

## License

Released under the [MIT License](https://opensource.org/licenses/MIT).

### Third-party notices

This project includes or derives data from the following open source projects:

1) libxcvt (CVT timing calculations)
- Source: https://github.com/KreitinnSoftware/libxcvt
- License: MIT (X11-style)

2) edid-decode (CTA VIC table data)
- Source: https://github.com/timvideos/edid-decode
- License: MIT (X11-style)

Copies of the licenses are available in their respective repositories.
