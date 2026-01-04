# EDID Generator

A minimal, web-based EDID generator focused on the essentials: choose a default mode, add extra modes, and toggle basic options like audio/HDR/VRR.

## Usage

Open `index.html` in a browser (or head to https://edid.build). Use the form to generate and download `edid.bin`. Done!

## Development

### How it's built

- Static HTML/CSS/JS with no build step; the EDID engine lives in `assets/edid-core.js`.
- Outputs an EDID 1.3 base block for HDMI VSDB compatibility (the HDMI VSDB spec targets EDID 1.3).
- Timings are generated using CVT with automatic reduced blanking when appropriate.
- CTA-861 VIC mappings come from `data/cta-861-g-vic.json`.
- DisplayID blocks are emitted when modes cannot fit CTA DTD/VDB limits.

### Automatic behavior

- Always includes a CTA-861 extension so HDMI audio/HDR/VRR signaling works.
- Default mode becomes the base-block preferred DTD; CTA VICs are listed in the CTA Video Data Block when available.
- HDMI capability is inferred from the highest-bandwidth mode (TMDS vs FRL rate).
- HDR enables 10-bit color; DSC auto-enables only when required. If DSC is off for extreme modes, the generator assumes 4:2:0 and marks only those CTA VICs as Y420-capable.
- DisplayID blocks are added as needed; modes are only dropped when they cannot fit in CTA or DisplayID blocks.
- VRR is opt-in; when enabled without multiple refresh rates per resolution, the UI notes that it won’t engage.
- "Reduce inferred modes" disables the range descriptor and GTF support to limit synthesized modes.

### Testing

Run the full test suite (Podman/Docker required):

```sh
./tests/run-tests.sh
```

Validate a single EDID with `edid-decode` (uses Podman/Docker if needed):

```sh
./tests/check-edid.sh path/to/edid.bin
```

The suite runs inside a container and fails on any unexpected generator or edid-decode warnings.

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
