# containers

Source for container images published to `ghcr.io/ryanbtv/<image-name>`. Each image is built, scanned, and published by [`.github/workflows/docker-build-pipeline.yml`](.github/workflows/docker-build-pipeline.yml). Every job runs on a GitHub-hosted runner.

## Images

| Directory | Published as | What it is |
| --- | --- | --- |
| [`images/arc-runner/`](images/arc-runner/README.md) | `ghcr.io/ryanbtv/arc-runner` | Runner image for a self-hosted ARC (Actions Runner Controller) scale set. Official actions-runner plus `gh`, `python3`, and the Docker Compose plugin. `linux/amd64` and `linux/arm64`. |
| `images/homelab-act/` | `ghcr.io/ryanbtv/homelab-act` | Pre-baked [`act`](https://github.com/nektos/act) runner image for Ansible playbook workflows. Ubuntu, Python, Ansible and collections, Azure CLI, Node. |
| [`images/netbox-mcp/`](images/netbox-mcp/README.md) | `ghcr.io/ryanbtv/netbox-mcp` | Zero-dependency NetBox MCP server (REST and read-only GraphQL) with a committed schema catalog. stdio by default, optional authenticated HTTP. |
| [`images/openchamber/`](images/openchamber/README.md) | `ghcr.io/ryanbtv/openchamber` | Upstream [OpenChamber](https://github.com/openchamber/openchamber), built from a pinned ref. Upstream publishes no image of its own. `linux/amd64` only. |

## Layout

An image is a self-contained directory under `images/`. The build context is that directory, not the repository root, so you can build any image by hand with one path:

```sh
docker build -t netbox-mcp:test images/netbox-mcp
```

| File | Required | Meaning |
| --- | --- | --- |
| `Dockerfile` | yes | Its presence is what puts the directory in the build matrix. |
| `README.md` | no | Rationale, configuration, and operational notes. |
| `VERSION` | no | A bare semver line. Adds a `v<x.y.z>` tag when present. |
| `TAG` | no | One bare container tag, such as a non-semver upstream release name, on a single non-empty line. Adds that tag on `main`. `latest` and `sha-*` are reserved and fail the build. |
| `.trivyignore` | no | Suppress a specific finding. Justify each entry in a comment. |

`openchamber/` is the exception. It holds no `Dockerfile`, so the matrix skips it, and a dedicated job builds it from upstream. See [`images/openchamber/README.md`](images/openchamber/README.md).

## Adding an image

1. Create `images/my-image/` and write a `Dockerfile` in it. The directory name must match `^[a-z0-9]+([._-][a-z0-9]+)*$`.
2. Keep every `COPY` relative to that directory.
3. Open a pull request. The matrix picks the directory up with no workflow edit, and builds and scans it without pushing.
4. Merge. The push to `main` publishes `ghcr.io/ryanbtv/my-image`.
5. On the first publish, set the new package's visibility and Actions access. See [Package settings](#package-settings).

The image name is the directory name. Nothing else derives from it.

## Tags

| Tag | When |
| --- | --- |
| `latest` | Non-pull-request events on `main`. |
| `<branch>` | Manual runs on any other branch. |
| `pr-<n>` | Pull request events. Built and scanned, never pushed. |
| `sha-<short>` | Every build. Use this when you need to redeploy an exact image. |
| `v<x.y.z>` | Non-pull-request events, when the directory has a `VERSION` file. |
| `<TAG>` | Non-pull-request events on `main`, when the directory has a `TAG` file. A branch build never pushes it, so a branch cannot overwrite the release tag. |
| `<upstream-ref>` | `openchamber` only: the ref in `UPSTREAM_REF`, with `/` replaced by `-`. |

Every image carries `org.opencontainers.image.source=https://github.com/ryanbtv/containers`, as a label and as an OCI annotation on the manifest and the multi-arch index, so GHCR links each package to this repository.

## Vulnerability scanning

Trivy runs on every build at `CRITICAL,HIGH` with `ignore-unfixed`, so a finding is only reported when a fix exists.

- **Images authored here fail the build on a finding.** Prefer fixing the image. Reach for a `.trivyignore` only when that does not work.
- **`openchamber` reports and continues.** It is upstream code, and a blocking gate would fail on findings that cannot be fixed from this repository. Findings go to the job summary.

## When builds run

Pushes to `main` and pull requests build only the images whose `images/<image>/` files changed, including hidden files, `VERSION`, `TAG`, `.trivyignore`, and OpenChamber's `UPSTREAM_REF`. Unrelated files select no images. Changes to the build workflow or to [the selector](.github/scripts/select-images.mjs) select every image. If the Git diff cannot be computed, discovery warns and selects every image.

`workflow_dispatch` is an explicit force override. Its optional `image` input builds that image even without source changes. A blank input builds all images. There is no scheduled rebuild: run a manual dispatch to refresh base images or rescan against newer vulnerability data.

The required checks are `discover` and `build-summary`. `build-summary` always reports and fails when a selected job did not succeed or an unselected job did not skip.

Publishing runs share one non-dropping concurrency queue. Before each push, the job compares its image inputs with current `main` and skips a stale publication, so an older queued run cannot overwrite a newer `latest`.

## Pull request safety

This repository is public, so:

- Pull requests build and scan only. They never log in to GHCR or push. Login and push steps are gated on `github.event_name != 'pull_request'`.
- There is no `pull_request_target` trigger.
- Workflow-level `permissions` is empty. Each job requests only what it needs. `packages: write` exists only on the build jobs, for the push steps. A pull request from a fork always gets a read-only token.

## Tests

Node 26.7.0 or newer. No dependencies.

```sh
node scripts/test.mjs            # every component
node scripts/test.mjs --list     # inventory only
node scripts/test.mjs --coverage # native coverage, awareness only
```

## Package settings

GHCR packages are configured on github.com, not in this repository. For each package (`arc-runner`, `homelab-act`, `netbox-mcp`, `openchamber`), under **Package settings**:

- **Manage Actions access:** add `ryanbtv/containers` with the **Write** role.
- **Danger Zone → Change visibility:** set **Public**.

## License

[MIT](LICENSE). `openchamber` is built from upstream MIT-licensed source; this repository vendors none of it.
