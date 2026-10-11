# ChatGPT Dots in Any Country

This opt-in feature removes the Linux client's local country and account
capability gates for ChatGPT Dots. It keeps the Dots route and capability
checks available when the account response is marked unavailable because of
the current network location.

The feature does not change the account entitlement, the request IP, or
server-side permissions. OpenAI may still reject Dots API requests or return
an unavailable route. This patch only lets the desktop client attempt the
existing Dots flow instead of stopping at the local country gate.

## Enable

Add the feature to the local, gitignored feature selection before rebuilding:

```json
{
  "enabled": ["chatgpt-dots-any-country"]
}
```

Then rebuild and restart ChatGPT Community. Feature selection is applied at
build time; changing a VPN while the app is running cannot update a bundle that
has already been loaded.

## Validate

```bash
node --test linux-features/chatgpt-dots-any-country/test.js
```
