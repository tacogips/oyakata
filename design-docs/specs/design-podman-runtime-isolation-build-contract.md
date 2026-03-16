# Podman Runtime Isolation Build Contract

This document defines the workflow authoring contract for Podman-oriented node
execution metadata, including when a node may reference a prebuilt image and
when it may reference a workflow-local Dockerfile/Containerfile path.

## Overview

The current runtime does not execute Podman-isolated nodes yet, but workflow
authoring already needs a canonical, validated place to declare how a future
Podman-backed execution should obtain its container image.

The design goals for this slice are:

- keep node-level container configuration explicit and portable
- prefer prebuilt image references for stable execution
- allow workflow-local build metadata when image publication is not yet part of
  the workflow author's process
- reject invalid or ambiguous Podman configuration during workflow validation
- fail clearly at runtime if a workflow attempts to execute a Podman-isolated
  node before the executor exists

## Authoring Model

Node payloads may declare:

```json
{
  "runtimeIsolation": {
    "mode": "podman",
    "image": "ghcr.io/example/reviewer:latest"
  }
}
```

or:

```json
{
  "runtimeIsolation": {
    "mode": "podman",
    "build": {
      "contextPath": "containers/reviewer",
      "dockerfilePath": "containers/reviewer/Dockerfile",
      "target": "runtime"
    }
  }
}
```

## Rules

- `runtimeIsolation.mode` may be `host` or `podman`
- `host` remains the default behavior when `runtimeIsolation` is omitted
- when `mode = "podman"`, exactly one image source must be declared:
  - `image`
  - `build`
- `build.contextPath` must be a workflow-relative path without `.` or `..`
  segments
- `build.dockerfilePath`, when provided, must also be workflow-relative without
  `.` or `..` segments
- `build.dockerfilePath` must not target canonical workflow definition files
  such as `workflow.json`, `workflow-vis.json`, or `node-*.json`
- `build.target`, when provided, must be a non-empty string

## Why Dockerfile Path Is Optional

The primary execution identity for Podman should still be an image reference.
That keeps runtime behavior reproducible and decouples node execution from local
build policy.

However, requiring every Podman workflow author to pre-publish an image is too
heavy for local development. The optional `build` block provides a canonical
place for workflow-local build metadata, including `dockerfilePath`, without
forcing all nodes into a Dockerfile-driven model.

## Runtime Behavior In This Slice

This slice does not introduce Podman execution itself.

Near-term runtime behavior:

- workflow validation accepts and preserves the isolation metadata
- runtime execution rejects Podman-isolated nodes with a clear unsupported
  error

This avoids silent no-op behavior or accidental host execution when authors have
explicitly asked for Podman isolation.
