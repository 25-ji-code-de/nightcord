# Navigation icons

Editable SVGs based on the supplied Nightcord film references.

The navigation rail uses a 32-unit grid and mostly 1.8-unit outlines.

After editing a source, run:

```powershell
node scripts/sync-navigation-icons.mjs
```

This updates the inline SVGs in `index.html` and `ui-manager.js`. Their
`currentColor` follows the active palette. Titles are retained in standalone
sources; inline decorative copies are hidden from assistive technology, with
accessible names and state supplied by their existing controls.
