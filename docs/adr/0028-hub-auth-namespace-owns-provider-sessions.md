# Hub auth namespace owns provider sessions

**Sandcastle Hub** separates API-key style credentials from provider login
sessions. `sandcastle env` remains the Hub env file interface for keys and
tokens. `sandcastle auth` owns provider CLI login/session setup, inspection,
and provider auth paths.

## Decision

Add a dedicated `sandcastle auth` command namespace for Hub provider auth:

```bash
sandcastle auth show
sandcastle auth path <provider>
sandcastle auth login codex
sandcastle auth login github
```

`sandcastle env init` may explain that a provider has a login/session path and
point users to `sandcastle auth login <provider>`, but it must not manage
provider session state directly. The env surface continues to store Hub env
values such as `OPENAI_KEY`, `GH_TOKEN`, `CURSOR_API_KEY`,
`OPENCODE_API_KEY`, and `ANTHROPIC_API_KEY`.

Hub-owned auth state defaults to the **Sandcastle user data directory**, so it
can be reused across Hub projects. Initial paths are provider-specific
directories under the Hub data area, for example:

- Codex: a Hub-owned `CODEX_HOME` directory.
- GitHub: a Hub-owned `GH_CONFIG_DIR` directory.

Existing API-key workflows remain compatible. Runtime env values continue to
take precedence over Hub env file values. Provider login/session support is an
additional auth source, not a replacement for API keys.

The first implementation should support:

- Codex login, with CLI copy that distinguishes OpenAI API-key billing from a
  Codex/ChatGPT CLI login session.
- GitHub login for GitHub Issues task sync.
- Status/guidance for providers that do not have first-pass login support.

Cursor, OpenCode, Claude Code, and Pi should not claim provider-login support
in the first pass. They can report env-key setup guidance through `auth show`.

## Consequences

- Hub onboarding can offer provider login without overloading the meaning of
  the Hub env file.
- First-time Codex setup can avoid steering users toward `OPENAI_KEY` when
  they intend to use a Codex/ChatGPT CLI login session.
- Auth session files stay out of target repos and out of `.sandcastle/`
  project scaffolds.
- Non-interactive commands that require browser or CLI login must fail with an
  actionable setup command instead of hanging or silently falling back.

## Considered Options

1. **Put provider login inside `sandcastle env init`** -- rejected because env
   is a key/value credential surface, while provider login produces session
   directories and provider-specific config state.
2. **Only support API keys in Hub v1** -- rejected because it makes Hub
   onboarding less capable than legacy init and can push Codex users toward the
   wrong billing/auth model.
3. **Use system keychain for all Hub auth** -- rejected for the first pass
   because cross-platform keychain behavior adds complexity before the Hub auth
   command surface has settled.
4. **Add a dedicated `sandcastle auth` namespace** -- chosen because it keeps a
   small public interface while preserving a clear boundary between env values
   and provider sessions.
