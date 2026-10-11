"use strict";

const COUNTRY_GATE = "fileLibraryEnabledForRegistrationCountry!==!1";

function applyChatgptDocsCountryGatePatch(source) {
  const occurrences = source.split(COUNTRY_GATE).length - 1;
  if (occurrences === 0) {
    return source;
  }
  if (occurrences !== 1) {
    console.warn(
      "WARN: Found multiple ChatGPT Docs country gates in one asset — skipping Docs country gate patch",
    );
    return source;
  }

  return source.replace(COUNTRY_GATE, "!0");
}

const descriptors = [
  [
    "app-initial",
    "startup Docs availability",
  ],
  [
    "add-sources-dialog",
    "project Docs source action",
  ],
  [
    "chatgpt-conversation-page",
    "project deletion Docs warning",
  ],
  [
    "personalization-settings",
    "personalization Docs setting",
  ],
].map(([assetStem, missingDescription]) => ({
  id: `docs-country-gate-${assetStem}`,
  phase: "webview-asset",
  order: 20_900,
  ciPolicy: "optional",
  pattern: new RegExp(`^${assetStem}-[^.]+\\.js$`),
  assetMatch: (source) => source.includes(COUNTRY_GATE),
  missingDescription,
  skipDescription: "ChatGPT Docs country gate patch",
  apply: applyChatgptDocsCountryGatePatch,
}));

module.exports = {
  COUNTRY_GATE,
  applyChatgptDocsCountryGatePatch,
  descriptors,
};
