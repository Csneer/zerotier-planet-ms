# Bootstrap layout and navigation subset

This directory contains the Bootstrap **3.4.1** layout assets and the two JavaScript plugins still used by the console. The source is [`twbs/bootstrap` commit `68b0d231a13201eb14acd3dc84e51543d16e5f7e`](https://github.com/twbs/bootstrap/tree/68b0d231a13201eb14acd3dc84e51543d16e5f7e), the `v3.4.1` tag. Assets were checked byte-for-byte against both that commit and the previously installed `bootstrap@3.4.1` package before the documented CSS transformation below. The license text also matches; npm's copy uses different line endings, and the original Git source bytes are retained here.

## Included assets

- `css/bootstrap.min.css`: existing grid, form, table, button and navigation presentation. The only change is removal of its trailing source-map reference, because the development source map is not shipped.
- `fonts/glyphicons-halflings-regular.*`: the upstream Glyphicons Halflings font formats. Existing settings, deletion confirmations and fallback icons still use `glyphicon` classes; keeping these files avoids missing icons and preserves the CSS font URLs.
- `js/transition.js` and `js/collapse.js`: unchanged upstream plugins, loaded in that order after jQuery. The responsive navigation uses `data-toggle="collapse"` and `#appNavigation`.
- `LICENSE`: the unchanged upstream MIT license. Upstream copyright notices remain in CSS and JavaScript.

The full Bootstrap JavaScript bundle is **not** included. In particular, tooltip and popover implementations are absent rather than merely disabled. The console's tooltips and dialogs use its own `ui-focus.js`; other Bootstrap JavaScript plugins are not used by the current templates. CSS selectors for those components may remain in the stylesheet, but they do not provide the omitted JavaScript behavior.

## Integrity and serving

`sources.json` records each original path, upstream SHA-256 and distributed SHA-256. Verify the distributed files from this directory with:

```bash
sha256sum -c SHA256SUMS
```

The image copies this directory to `/usr/share/zerotier-planet/bootstrap`. Express serves its `css`, `fonts` and `js` subdirectories at `/bscss`, `/fonts` and `/bsjs`; the old `/bsjs/bootstrap.min.js` endpoint has no bundled file. No assets are fetched from a CDN at runtime.

Removing the npm package does not turn these files into a newer Bootstrap release. This is a documented, maintained subset of 3.4.1. Review any future advisory against the shipped CSS, fonts and plugins, and verify mobile navigation and legacy icon rendering before refreshing or removing them. To add a different Bootstrap component, first review its behavior and security history instead of restoring the full bundle.
