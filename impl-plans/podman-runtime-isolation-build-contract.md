# Podman Runtime Isolation Build Contract Implementation Plan

**Status**: Completed
**Design Reference**: `design-docs/specs/design-podman-runtime-isolation-build-contract.md`
**Created**: 2026-03-16
**Last Updated**: 2026-03-16

## Scope

Implement the workflow authoring and validation slice for Podman runtime
isolation metadata, including optional Dockerfile-path build metadata, without
adding a real Podman executor in this session.

In scope:

- add typed `runtimeIsolation` metadata to node payloads
- validate `podman` image/build authoring rules
- preserve the metadata through workflow load/validation
- fail clearly if runtime execution targets a Podman-isolated node

Out of scope:

- command-node runtime execution
- Podman image build orchestration
- mailbox mount preparation inside containers

## Modules

### 1. Types and Validation

#### `src/workflow/types.ts`

**Status**: COMPLETED

```ts
export interface RuntimeIsolationBuild {
  readonly contextPath: string;
  readonly dockerfilePath?: string;
  readonly target?: string;
}

export interface RuntimeIsolation {
  readonly mode: "host" | "podman";
  readonly image?: string;
  readonly build?: RuntimeIsolationBuild;
}
```

**Checklist**:

- [x] Add `runtimeIsolation` types to node payloads
- [x] Preserve additive compatibility for existing agent nodes

#### `src/workflow/validate.ts`

**Status**: COMPLETED

**Checklist**:

- [x] Validate `podman` image/build exclusivity
- [x] Validate workflow-relative `build` paths
- [x] Preserve normalized metadata in the validated node payload

### 2. Runtime Guard

#### `src/workflow/engine.ts`

#### `src/workflow/call-node.ts`

**Status**: COMPLETED

**Checklist**:

- [x] Reject execution of Podman-isolated nodes with a deterministic error
- [x] Keep existing agent execution behavior unchanged

### 3. Regression Tests

#### `src/workflow/validate.test.ts`

#### `src/workflow/load.test.ts`

#### `src/workflow/engine.test.ts`

#### `src/workflow/call-node.test.ts`

**Status**: COMPLETED

**Checklist**:

- [x] Accept valid Podman build metadata with `dockerfilePath`
- [x] Reject ambiguous or unsafe build/image configuration
- [x] Verify metadata survives workflow loading
- [x] Verify execution fails clearly before a Podman executor exists

## Completion Criteria

- [x] Node payloads can declare Podman image or build metadata
- [x] Validation enforces exact image/build rules
- [x] Runtime rejects unsupported Podman execution explicitly
- [x] Focused tests pass
- [x] Type checking passes

## Progress Log

### Session: 2026-03-16 21:40 JST

**Tasks Completed**: Types, validation, runtime guard, and focused regression tests
**Tasks In Progress**: None
**Blockers**: None
**Notes**: Chose the smallest coherent slice that answers the Dockerfile-path question directly: preserve and validate Podman build metadata now, but reject actual Podman execution until a command/container executor exists.
