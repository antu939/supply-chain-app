# Maintenance patch — workspace preservation and regression fixes

## Production fix
- `shared/bridge.js`: removed the destructive one-time initialization routine.
  Loading the bridge now has no browser-storage side effects, whether the old
  marker is absent, unset or present. Existing BOM/Sales data, backup copies,
  AI history, audit records and configuration are preserved.
- Fresh workspaces continue to be initialized by the existing BOM and Sales
  modules. The obsolete search endpoint is still excluded by the existing
  AI settings loader. No business model, storage schema, AI tool or UI redesign.

## Regression and distribution fixes
- Added `tests/bridge-storage-regression.js` (5 tests) for existing data,
  marker variations, repeated loads, empty storage and denied storage access.
  The original bridge fails this regression.
- Updated stale English UI/error-message assertions in
  `tests/sales-facts-regression.js`, `tests/sales-simulation-regression.js`,
  `tests/stage1-check.js` and `modules/bom/tests/regression.js`.
  Business-value, state and validation checks remain in place.
- Restored the three Chinese filenames from the original ZIP's unflagged
  UTF-8 names; the BOM example and both usage guides retain their original bytes.
- Excluded macOS `__MACOSX` and `.DS_Store` metadata from the new archive.

## Verification
Node.js v22.16.0: all 17 JavaScript test scripts passed, including both
module test suites. To run them from the project root on macOS/Linux:

```sh
node --test tests/*.js modules/*/tests/*.js
```

This is a source maintenance patch, not a desktop installer. It prevents
future deletion by the bridge; it cannot restore data previously deleted.
Browser UI, actual model API calls and desktop packaging still require
their own validation. Back up existing workspace data before upgrading,
and keep the same origin/profile if using browser localStorage.
