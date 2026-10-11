# ChatGPT Docs in Any Country

This opt-in feature removes the Linux bundle's local country gate for the
ChatGPT Docs/Library entry points. It changes the client-side interpretation of
`fileLibraryEnabledForRegistrationCountry === false` so the UI can be opened
after the account has already been authenticated in a different network
location.

The feature does not change the account, the registration country, the request
IP, or server-side permissions. OpenAI may still reject a Docs/Library request,
and enabling the feature does not make an account eligible for a service that
is unavailable to it. The patch only exposes the existing entry points so the
server response is observable instead of being hidden by the desktop client.

## Enable

Add the feature to the local, gitignored feature selection before rebuilding:

```json
{
  "enabled": ["chatgpt-docs-any-country"]
}
```

Then rebuild and restart ChatGPT Community. Feature selection is applied at
build time; switching a VPN while the app is running cannot update a bundle
that has already been loaded.

## Validate

```bash
node --test linux-features/chatgpt-docs-any-country/test.js
```
