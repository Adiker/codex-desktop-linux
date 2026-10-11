#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { loadLinuxFeaturePatchDescriptors } = require("../../scripts/lib/linux-features.js");
const { patchUniqueAssetFile } = require("../../scripts/patches/lib/assets.js");
const {
  COUNTRY_GATE,
  applyChatgptDocsCountryGatePatch,
  descriptors,
} = require("./patch.js");

const ASSET_NAMES = [
  "app-initial-current.js",
  "add-sources-dialog-current.js",
  "chatgpt-conversation-page-current.js",
  "personalization-settings-current.js",
];

function withFeatureConfig(enabled, fn) {
  const originalConfig = process.env.CODEX_LINUX_FEATURES_CONFIG;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "chatgpt-docs-any-country-"));
  process.env.CODEX_LINUX_FEATURES_CONFIG = path.join(tempDir, "features.json");
  try {
    fs.writeFileSync(process.env.CODEX_LINUX_FEATURES_CONFIG, JSON.stringify({ enabled }));
    return fn();
  } finally {
    if (originalConfig == null) {
      delete process.env.CODEX_LINUX_FEATURES_CONFIG;
    } else {
      process.env.CODEX_LINUX_FEATURES_CONFIG = originalConfig;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

test("feature is disabled until selected", () => {
  const featuresRoot = path.resolve(__dirname, "..");
  withFeatureConfig([], () => {
    assert.equal(
      loadLinuxFeaturePatchDescriptors({ featuresRoot })
        .some((descriptor) => descriptor.id.startsWith("feature:chatgpt-docs-any-country:")),
      false,
    );
  });

  withFeatureConfig(["chatgpt-docs-any-country"], () => {
    const loaded = loadLinuxFeaturePatchDescriptors({ featuresRoot })
      .filter((descriptor) => descriptor.id.startsWith("feature:chatgpt-docs-any-country:"));
    assert.deepEqual(
      loaded.map((descriptor) => descriptor.id),
      ASSET_NAMES.map((name) => `feature:chatgpt-docs-any-country:docs-country-gate-${name.replace(/-[^-]+\.js$/, "")}`),
    );
  });
});

test("country gate is replaced with an unconditional local availability value", () => {
  const source = `let enabled=data?.${COUNTRY_GATE};`;
  const patched = applyChatgptDocsCountryGatePatch(source);
  assert.equal(patched, "let enabled=data?.!0;");
  assert.equal(applyChatgptDocsCountryGatePatch(patched), patched);
});

test("ambiguous country gates fail closed", () => {
  const source = `${COUNTRY_GATE};${COUNTRY_GATE}`;
  assert.equal(applyChatgptDocsCountryGatePatch(source), source);
});

test("each current Docs asset descriptor patches only its matching asset", () => {
  const extractedDir = fs.mkdtempSync(path.join(os.tmpdir(), "chatgpt-docs-any-country-assets-"));
  const assetsDir = path.join(extractedDir, "webview", "assets");
  fs.mkdirSync(assetsDir, { recursive: true });
  try {
    for (const name of ASSET_NAMES) {
      fs.writeFileSync(path.join(assetsDir, name), `const gate=${COUNTRY_GATE};`);
    }
    for (const [index, descriptor] of descriptors.entries()) {
      const result = patchUniqueAssetFile(
        extractedDir,
        descriptor.pattern,
        descriptor.assetMatch,
        descriptor.apply,
        "missing",
        "ambiguous",
      );
      assert.deepEqual(result, { matched: 1, changed: 1, assetName: ASSET_NAMES[index] });
      assert.equal(fs.readFileSync(path.join(assetsDir, ASSET_NAMES[index]), "utf8"), "const gate=!0;");
    }
  } finally {
    fs.rmSync(extractedDir, { recursive: true, force: true });
  }
});
