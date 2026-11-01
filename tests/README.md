# The attack suite

Run these commands from the root of a clone:

```bash
npx playwright install webkit firefox    # once; Chrome itself must be installed
npm test                                 # build, then every attack in three browsers
```

In the attack suite, hostile widgets try to escape the jail, leak data, and do
more than darzi allows. The attacks are in
[`tests/attacks/`](attacks/) in the repo. They are not in the npm package, so run them from a clone. Each test that
expects an attack to fail has a positive control. The control runs the same
attack without the defense and expects it to succeed.

The witness is a server outside the browser that records the traffic it gets
(HTTP on `127.0.0.1:9999`, UDP on `:3478`). The witness is outside the browser
because you cannot trust a page to report on itself. Retries are off, so a test
that passes by chance cannot hide a leak. A release gets a tag only when all
tests pass.

`node tests/mutations/run.mjs` shows that the tests can fail. It breaks each
control in a copy of the repo, one at a time, and expects its test to go red. It
takes some minutes, so `npm test` does not run it. Run it before a release.

A probe in `tests/probes/` asks a real model to repair a widget whose error
text contains an attack. The probe needs an API key, so `npm test` does not run
it.

## Old browsers

Each release runs this suite only in current versions of Chrome, WebKit, and
Firefox. We also ran it once by hand in Playwright's builds of Chromium 101 and
115, Firefox 97 and 115, and WebKit 15.4 and 17.0. These builds are not the
browsers that users install. The results:

- No widget request reached the witness.
- In both WebKit builds, an `<object>` element crashed the page, also on a page
  with no darzi.
- In Firefox 97, a canvas call can fail in two nested sandboxed frames, also with
  no darzi. A widget that draws can then report a `script-error` fault.
- In both WebKit builds and Firefox 97, WebAssembly compiles in a widget, because
  these engines do not apply the CSP to it.
- Most tests of your page's CSP could not run on these builds, because the old
  test tool needs `eval`.
