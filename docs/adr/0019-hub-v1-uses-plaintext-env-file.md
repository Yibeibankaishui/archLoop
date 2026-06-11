# Hub v1 uses a plaintext env file

**Sandcastle Hub** v1 stores shared credentials in a plaintext **Hub env file** under the **Sandcastle user data directory**, with `process.env` allowed to override values at runtime. This is not a secret vault; it is a user-local convenience layer that replaces repeated per-project `.sandcastle/.env` setup for Hub flows while preserving the current `.env` mental model.

## Considered Options

1. **Store only credential references** -- rejected because references often point to another plaintext file and do not materially improve the v1 security model.
2. **Use system keychain as the only v1 backend** -- rejected because it would add cross-platform complexity before the Hub run model is proven.
3. **Use a Hub-owned plaintext `.env`** -- chosen because it solves repeated credential setup, matches existing Sandcastle usage, and can later coexist with keychain or native auth backends.
