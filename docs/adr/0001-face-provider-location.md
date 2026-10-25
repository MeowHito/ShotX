# ADR 0001: FaceProvider lives in packages/face

- Status: Accepted
- Date: 2026-10-25

## Context

The platform spec puts Amazon Rekognition behind a `FaceProvider` interface but doesn't say which
package owns it. The agent briefs disagreed with the code:

- `contracts.md` listed the `FaceProvider` interface (types only) as part of `packages/shared`.
- `face-poc.md` said face-poc implements "the FaceProvider interface from packages/shared".
- The code defines the interface in `packages/face/src/provider.ts`, next to
  `RekognitionFaceProvider`, `FakeFaceProvider`, indexing and search.

The Rekognition collection name (`pg-{photographerId}`) had no builder at all, so every caller would
hand-write it. A wrong collection id is a tenant-isolation bug: it searches or indexes another
photographer's faces.

## Decision

1. `packages/face` (`@shotx/face`) owns the face boundary, and face-poc owns `packages/face`:
   - the `FaceProvider` interface and its request/result types,
   - `NoFaceDetectedError`,
   - the collection-name builder `faceCollectionId(photographerId)`, which returns
     `pg-{photographerId}`,
   - `RekognitionFaceProvider`, and `FakeFaceProvider` in `@shotx/face/testing`.
2. Face configuration stays in `packages/shared`, owned by contracts: the `FACE_*` key names,
   defaults and ranges, `loadFaceConfig`, and the `FaceConfig`, `FaceThresholds` and
   `QualityFilter` types. face-poc changes them only through a CONTRACT CHANGE REQUEST.
3. `@shotx/face` may depend on `@shotx/shared`; `@shotx/shared` never depends on `@shotx/face`.
4. api and worker get face recognition only from `@shotx/face`. They never call the Rekognition SDK
   directly and never build a collection id by hand. Tests use `FakeFaceProvider`.

## Rationale

- The interface changes together with its implementations and the evaluation harness. Phase 0
  tuning (quality filter, tiling, expansion) reshapes requests, and one owner can change the
  interface, both providers and the harness in a single change.
- `packages/shared` stays free of Rekognition specifics: API size limits, error mapping, collection
  naming.
- The configuration is different: api, worker and infra must read the same keys and defaults, so
  it stays with the other tunables in `packages/shared`.

## Alternatives considered

- **Interface in `packages/shared`, implementations in `packages/face`.** This matched the original
  briefs, but every tuning change would need a CONTRACT CHANGE REQUEST round trip before face-poc
  could change its own implementation.
- **Everything, configuration included, in `packages/face`.** Rejected because the configuration
  would then be split across two packages with two owners.

## Consequences

- contracts must not add face provider types to `packages/shared`.
- Exported names of `@shotx/face` follow the same rule as contracts: face-poc never renames or
  removes one without listing every consumer (api, worker, tools) in its report.
- `faceCollectionId` must be called with a photographer id that the server resolved (the file's or
  share's `owner_id`), never with an id sent by the client.
- Importing `@shotx/face` pulls in `sharp` and the AWS SDK. If that becomes a problem for the API
  image, face-poc can add narrower subpath exports. That doesn't need a new ADR.
