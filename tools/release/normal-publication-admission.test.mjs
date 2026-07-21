import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  loadNormalPublicationAdmission,
  normalPublicationAdmissionDocument,
  writeNormalPublicationAdmission,
} from "./normal-publication-admission.mjs";

const lock = {
  lockDigest: "a".repeat(64),
  catalogDigest: "b".repeat(64),
  packageEnvelopeDigest: "c".repeat(64),
  source: { commit: "d".repeat(40), tree: "e".repeat(40) },
};
const cargo = {
  id: "carrier:cargo:input",
  kind: "carrier",
  ecosystem: "cargo",
  carrierId: "cargo:input",
  dependencies: [],
  operationOrder: 0,
};
const npm = {
  id: "carrier:npm:@example/sdk",
  kind: "carrier",
  ecosystem: "npm",
  carrierId: "npm:@example/sdk",
  dependencies: [cargo.id],
  operationOrder: 1,
};
const maven = {
  id: "maven:atomic-deployment",
  kind: "maven-atomic-deployment",
  ecosystem: "maven",
  carrierIds: ["maven:dev.example:a", "maven:dev.example:b"],
  dependencies: [],
  operationOrder: 2,
};
const plan = { operations: [cargo, npm, maven] };
const checkpoint = {
  checkpointDigest: "f".repeat(64),
  completedOperations: [cargo.id],
};
const assessment = {
  decision: "execute",
  authoritativeMutationWindowSeconds: 11_400,
  minimumMutationWindowSeconds: 2_700,
  completedOperationIds: [cargo.id],
  admittedOperationIds: [maven.id],
  unadmittedOperationIds: [npm.id],
};

describe("normal publication admission", () => {
  test("binds one ordered dependency-closed subset to the exact lock, plan, and checkpoint", () => {
    const root = mkdtempSync(path.join(tmpdir(), "normal-admission-"));
    try {
      const file = path.join(root, "admission.json");
      const written = writeNormalPublicationAdmission(file, {
        assessment,
        checkpoint,
        lock,
        plan,
        products: ["fixture"],
      });
      const loaded = loadNormalPublicationAdmission(file, {
        authoritativeWindowSeconds: 11_400,
        checkpoint,
        lock,
        plan,
        products: ["fixture"],
      });
      expect(loaded).toEqual(written);
      expect(loaded).toMatchObject({
        completedOperationIds: [cargo.id],
        admittedOperationIds: [maven.id],
        unadmittedOperationIds: [npm.id],
        publicationCompleteAfterAdmission: false,
      });

      const tampered = JSON.parse(readFileSync(file, "utf8"));
      tampered.admittedOperationIds = [npm.id];
      tampered.unadmittedOperationIds = [maven.id];
      writeFileSync(file, `${JSON.stringify(tampered)}\n`);
      expect(() => loadNormalPublicationAdmission(file, {
        authoritativeWindowSeconds: 11_400,
        checkpoint,
        lock,
        plan,
        products: ["fixture"],
      })).toThrow(/digest does not match/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects stale checkpoints, non-partitions, and zero-progress incomplete execution", () => {
    expect(() => normalPublicationAdmissionDocument({
      assessment: {
        ...assessment,
        completedOperationIds: [],
        unadmittedOperationIds: [cargo.id, npm.id],
      },
      checkpoint,
      lock,
      plan,
      products: ["fixture"],
    })).toThrow(/bound checkpoint/u);
    expect(() => normalPublicationAdmissionDocument({
      assessment: {
        ...assessment,
        admittedOperationIds: [maven.id],
        unadmittedOperationIds: [npm.id, maven.id],
      },
      checkpoint,
      lock,
      plan,
      products: ["fixture"],
    })).toThrow(/exactly partition/u);
    expect(() => normalPublicationAdmissionDocument({
      assessment: {
        ...assessment,
        admittedOperationIds: [],
        unadmittedOperationIds: [npm.id, maven.id],
      },
      checkpoint,
      lock,
      plan,
      products: ["fixture"],
    })).toThrow(/nonzero durable progress/u);
  });
});
