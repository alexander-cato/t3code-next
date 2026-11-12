import { assert, it } from "@effect/vitest";

import {
  assertStageLockfileIntegrity,
  createStageLockfile,
  StageLockfileError,
} from "./stage-lockfile.ts";

const source = `---
lockfileVersion: '9.0'
importers: {}
packages: {}
snapshots: {}
---
lockfileVersion: '9.0'
settings:
  autoInstallPeers: true
importers:
  apps/desktop:
    dependencies:
      runtime:
        specifier: ^1.0.0
        version: 1.0.1(peer@2.0.0)
    devDependencies:
      electron:
        specifier: 44.10.1
        version: 44.10.1
packages:
  runtime@1.0.1:
    resolution: {integrity: sha512-reviewed-runtime}
  peer@2.0.0:
    resolution: {integrity: sha512-reviewed-peer}
  electron@44.10.1:
    resolution: {integrity: sha512-reviewed-electron}
  '@ff-labs/fff-bin-darwin-x64@0.11.0':
    resolution: {integrity: sha512-reviewed-x64}
  '@ff-labs/fff-bin-darwin-arm64@0.11.0':
    resolution: {integrity: sha512-reviewed-arm64}
snapshots:
  runtime@1.0.1(peer@2.0.0):
    dependencies: {peer: 2.0.0}
  peer@2.0.0: {}
  electron@44.10.1: {}
  '@ff-labs/fff-bin-darwin-x64@0.11.0': {}
  '@ff-labs/fff-bin-darwin-arm64@0.11.0': {}
`;

it("keeps reviewed package bytes, peer versions, and cross-platform roots in staged lockfiles", () => {
  const staged = createStageLockfile(
    source,
    {
      dependencies: {
        runtime: "^1.0.0",
        "@ff-labs/fff-bin-darwin-x64": "0.11.0",
        "@ff-labs/fff-bin-darwin-arm64": "0.11.0",
      },
      devDependencies: { electron: "44.10.1" },
    },
    {},
  );
  assert.include(staged, "version: 1.0.1(peer@2.0.0)");
  assertStageLockfileIntegrity(source, staged);
  assert.throws(
    () =>
      assertStageLockfileIntegrity(
        source,
        staged.replace("sha512-reviewed-peer", "sha512-unreviewed-peer"),
      ),
    StageLockfileError,
  );
  assert.throws(
    () => assertStageLockfileIntegrity(source, staged.replaceAll("peer@2.0.0:", "peer@2.0.1:")),
    StageLockfileError,
  );
  assert.throws(
    () => createStageLockfile(source, { dependencies: { runtime: "^2.0.0" } }, {}),
    StageLockfileError,
  );
});
