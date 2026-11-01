# Browser regression

Requires Node.js 24+, Docker access, and a locally built project image.

```bash
npm ci --prefix tests/browser
cd tests/browser
npx playwright install --with-deps chromium
npm test -- zerotier-planet:ci-test
```

For a preinstalled Chrome binary, set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/google-chrome` instead of downloading Chromium.

The runner creates a dedicated Docker bridge, a 2-vCPU / 2-GiB instance with swap disabled and anonymous data volumes, and a dynamically assigned loopback-only HTTP port. It accepts only an image argument, never a remote application URL. Container, anonymous volumes, and network are removed in `finally`, including failed assertions. Run it against a disposable local build; the tests deliberately create networks, alter members, and inject browser-side failed responses.

The runner also executes the image’s actual rename and member handlers with failing controller/storage dependencies to verify backend error responses. Its final Docker CPU/memory sample is a single observation during this regression, not a throughput or capacity benchmark.
