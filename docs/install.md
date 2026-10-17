# Install and verify

> Chinese version: [install.zh-CN.md](install.zh-CN.md).

A procedure for a machine that has never run this plugin: what to install, how to
know it worked, and what to do when it did not. Every command is meant to be run
and read, in order, by a person or by an agent driving one.

Three install routes are covered. **Route A is the one this fork exists for** — you
are installing a working tree, not a published package, because the changes you
want are not on npm.

## Before you start

| Requirement | How to check | If it fails |
|---|---|---|
| Node.js ≥ 20 | `node -v` | Install Node 20 or newer |
| `pnpm` on the harness's PATH | `pnpm -v` | `dsh plugin add` forwards to pnpm; without it the add fails |
| An OpenCode Go subscription | [the console](https://opencode.ai/console) | The routes will answer `401` — the plugin loads, but no model will work |
| A key for that subscription | the console's key page | See [Give it a key](#give-it-a-key) |

## Route A — install this working tree (the usual case here)

```sh
git clone https://github.com/firstsaofan/dsh-opencode-go.git
cd dsh-opencode-go
dsh plugin --profile web add .
```

The trailing `.` is the whole mechanism: `dsh plugin` forwards to pnpm in the
profile directory, pnpm links the checkout as a `link:` dependency, and because
`package.json` declares `dsh.bundle.patch`, DSH appends it to
`dsh.profile.bundles` so it becomes a configuration layer rather than a stray
dependency.

Three things about this route:

- **Run it from the repository root.** A relative spec anchors to the directory
  you are in, so `add .` means "this checkout".
- **Keep the checkout where it is.** A `link:` target that moves breaks the
  profile.
- **Edits apply after a restart**, not after a reload. Change code, restart,
  done — which is the whole reason to prefer this route while working on it.

Then **fully restart the profile**: bundle layers are read at startup only.

```sh
dsh --profile web
```

## Route B — install from your fork at a fixed commit

Use this on a machine where you want an exact, reproducible copy rather than a
live checkout.

```sh
dsh plugin --profile web add github:firstsaofan/dsh-opencode-go#<40-character-commit>
```

Pin the commit. A branch ref means every reinstall can resolve to different code,
which is the opposite of what a fixed install is for.

This route needs no build step, and that is unusual for a DSH plugin: the package
ships its `lib/` in the repository and declares no `prepare` script, so pnpm has
nothing to refuse under `allowBuilds`. It is also worth knowing that `github:`
installs **source**, so a package that needed a build would arrive without its
output — not a problem here.

## Route C — install from npm

```sh
dsh plugin --profile web add dsh-llm-opencode-go
```

This gets the **published** package, not this working tree. Choose it only when
you want upstream's behaviour deliberately; in particular upstream defaults
`healthCheck` to `off`, while this fork defaults it to `both`
(see [Endpoint health](health.md)).

## Verify

Three checks, cheapest first. All three are read-only.

**1. The route is registered.**

```sh
dsh --profile web --dump-config
```

Look for `dsh-llm-opencode-go` in the bundle list, and for a layer whose patch is
this repository's `cordis.patch.yml`.

**2. The readiness line was logged.** Start the profile and read the log:

```
dsh-llm-opencode-go: provider "opencode-go" ready at https://opencode.ai/zen/go/v1 (credential OPENCODE_GO_API_KEY, models discover)
```

The two fields worth reading closely are the **credential reference** and the
**base URL**. The reference is whatever `apiKeyEnv` resolved to — see the next
section for why that is the first thing to check when a model will not answer.

**3. The endpoint is reachable, for free.** From the repository root:

```sh
npm run probe
```

It sends three requests that cannot generate anything and prints what each route
answered. No key needed, no quota spent. `alive` on every line is the success
case — a probe that is working looks like a series of refusals, because that is
how a live route is told apart from a retired one. See
[Endpoint health](health.md) for what each verdict means.

## Give it a key

Either export the variable in the environment that launches DSH, or store it
through the credential seam — the web Models page writes it, and so does the
plugin's own settings page. The plugin resolves the reference **per request**, so
both work and neither needs a restart.

```sh
export OPENCODE_GO_API_KEY=...        # must match the reference in the readiness line
```

**Check the reference name before anything else.** The default is
`OPENCODE_GO_API_KEY`, but it is a field like any other:

```yaml
config:
  apiKeyEnv: OPENCODEGO_API_KEY
```

A key stored under a name the route does not read produces the same symptom as a
wrong key — every model refuses with `401` — and the readiness line is what tells
the two apart. This is the single most common reason a correct key appears not to
work.

## First-run configuration

Nothing is required. The defaults are:

| Field | Default | What that means for you |
|---|---|---|
| `healthCheck` | `both` | **This fork** watches the API root every six hours and reacts to a live refusal. Upstream's default is `off`; set it if you want that |
| `apiKeyEnv` | `OPENCODE_GO_API_KEY` | Change this if your key lives under another name |
| `baseURL` | `https://opencode.ai/zen/go/v1` | A flat root the vendor no longer documents but still serves |
| `modelSource` | `discover` | The model list is read from the service, not hand-written |

Everything else is in [Configuration](configuration.md).

## When it does not work

| Symptom | Cause | Fix |
|---|---|---|
| `dsh plugin add` fails on a pnpm error | `pnpm` not on the harness's PATH | Put pnpm on PATH, retry |
| The add succeeds, the profile starts, the route is absent | The package was not added as a bundle | `package.json` must declare `dsh.bundle`; check `dsh --profile web --dump-config` for the layer |
| Everything works, then breaks after a `git pull` | The checkout moved or was deleted | A `link:` target must stay put |
| Every model answers `401` | The key is not where the route reads it | Compare the readiness line's credential reference with the variable you exported |
| Every model answers `401` and the reference is right | The key belongs to a workspace with no Go subscription | Keys are per-workspace; generate it in the subscribed one |
| `404` on some models only | Those models moved to another protocol | The settings page's **Endpoint health** section names the root that serves them |
| `400 MissingSessionID` | A relay began requiring `x-opencode-session` | Do not set `sessionHeader: off` |
| `400` on every model, shortly after a long session | Output budget against the context window | `/compact`, or lower the model's *Max output* |

The first two rows are install problems; everything after them is configuration,
and the [Configuration](configuration.md) page owns that.

## Uninstall

```sh
dsh plugin --profile web remove dsh-llm-opencode-go
```

Then fully restart the profile. Note that a `link:` route leaves the checkout on
disk — nothing removes it for you, and nothing should.