<div align="center">

# DSH CUA Helper

**Community builds of the native Computer Use helpers for DeepSeek Harness, matched to upstream release tags.**

English | [简体中文](README.zh_CN.md)

</div>

## Download

1. Find the exact version of the DeepSeek Harness (DSH) instance you run. For example, `0.2.3-alpha.2` maps to the `dsh-v0.2.3-alpha.2` tag in [Releases](https://github.com/dsh-plugins/dsh-cua-helper/releases). Do not mix helper and DSH versions.
2. Download `cua-helper-<tag>-<target>.zip` and `SHA256SUMS`. Compare the ZIP's SHA-256 with its line in the manifest, then extract the entire ZIP to a persistent, user-writable directory outside `node_modules`.
3. Keep the executable with its runtime files on Windows and keep the whole `.app` on macOS. Enable the built-in Computer Use bundle in DSH, then configure the helper path below.

| Target | Runner | Package and checks |
| --- | --- | --- |
| `win-x64` | `windows-2025` | Self-contained .NET ZIP; unsigned; x64 protocol test and PE architecture check |
| `win-arm64` | `windows-2025` | Self-contained .NET ZIP; unsigned; cross-build and PE architecture check, without an ARM64 runtime test |
| `darwin-arm64` | `macos-15` | Complete `.app` in a ZIP; ad-hoc signed, not notarized; native Swift tests, signature and Mach-O architecture checks |
| `darwin-x64` | `macos-15-intel` | Complete `.app` in a ZIP; ad-hoc signed, not notarized; native Swift tests, signature and Mach-O architecture checks |

Linux has no upstream native helper. WSL is not a Linux build target and has separate upstream configuration and limitations. Historical tags only build the targets supported by their sources. GitHub-hosted builds do not test interactive desktop access or system permission prompts. macOS Gatekeeper may restrict the non-notarized community build; consult Apple and your administrator's security guidance. Use the upstream-signed macOS distribution if your policy requires it.

On Windows, print the downloaded ZIP's digest with `Get-FileHash -Algorithm SHA256 -LiteralPath 'C:\Downloads\cua-helper-dsh-v0.2.3-alpha.2-win-x64.zip'`. On macOS, place `SHA256SUMS` beside the ZIP and use `shasum -a 256 -c --ignore-missing SHA256SUMS`, or compute the selected ZIP's hash directly with `shasum -a 256`.

## Setup

Find the active profile's `cordis.patch.yml`. Edit the existing provider entry, or add a patch for its ID if your profile has none. The patch replaces the entire provider `config`: retain any existing settings alongside `helperPath`. Keep the built-in bundle enabled. For DSH `0.2.3-alpha.2`, these are example patches (use only the one for your platform):

```yaml
- id: cua-windows
  config:
    agentPreset: ptc
    helperPath: 'C:\Users\example\Tools\dsh-cua-helper\dsh-cua-windows.exe'
```

```yaml
- id: cua-macos
  config:
    agentPreset: ptc
    helperPath: '/Users/example/Tools/dsh-cua-helper/DSH Computer Use Dev.app/Contents/MacOS/dsh-cua-native'
```

Adjust the path to the exact extracted executable, restart the DSH instance, and check the Computer Use settings. On macOS, allow the helper's Accessibility and Screen Recording access only if you intend to grant it. See the upstream setup documentation for [Windows](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.3-alpha.2/packages/experimental/cua-windows/README.md#setup) and [macOS](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.3-alpha.2/packages/experimental/cua-macos/native/README.md#build-and-service).

## Synchronization and manual builds

[Mirror CUA helpers](https://github.com/dsh-plugins/dsh-cua-helper/actions/workflows/mirror.yml) checks upstream published releases at minute 17 every hour (UTC, subject to GitHub scheduling). It includes prereleases, begins at `dsh-v0.2.3-alpha.2`, and does not rebuild complete releases. Each run picks a batch of up to eight pending tags; remaining tags and failures are eligible in later runs. To build an exact tag, including an older one, choose **Run workflow** on `main`, enter `upstream_tag`, or run:

```sh
gh workflow run mirror.yml --repo dsh-plugins/dsh-cua-helper --ref main -f upstream_tag=dsh-v0.2.3-alpha.2
```

The workflow resolves the exact upstream commit and stores only the native sources, build inputs, and license under `versions/<tag>/`. Its `source.json` records the upstream commit and build targets. A same-named Git tag points to the mirrored snapshot; the corresponding GitHub Release becomes public only after all its expected assets and checksums pass validation. Failed tags can be retried without replacing public assets. Only the isolated publishing job has write permission, using the repository's automatic `GITHUB_TOKEN`; no additional secrets are needed. Upstream sources and built executables do not run in that job.

## Local validation

Run `node --test` and `actionlint` in this repository. To build from a committed snapshot on Windows, install the .NET 10 SDK and run:

```powershell
node scripts/build.mjs versions/dsh-v0.2.3-alpha.2 win-x64 out
```

On a compatible macOS host with Xcode 26.3 and Python 3, use:

```sh
node scripts/build.mjs versions/dsh-v0.2.3-alpha.2 darwin-arm64 out
```

Use an empty output directory. The script writes the ZIP and a JSON file with its digest and build identity. CI publishes the ZIPs and a consolidated `SHA256SUMS` file.

For `dsh-v0.2.3-alpha.2`, the macOS build applies a Swift compiler compatibility fix to the temporary build copy. It keeps window geometry reads in the existing synchronous accessibility code and preserves the original check order. The snapshot retains the tagged upstream files. Intel runs the full Swift suite. Apple Silicon runs the native protocol and window geometry smoke tests because the full suite stalled on its hosted runner.

## License

This independent project is not an official DeepSeek distribution. [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) owns the original helper source. Each snapshot and package includes its upstream MIT license, and packages retain applicable third-party notices. Repository automation is available under the [MIT license](LICENSE).
