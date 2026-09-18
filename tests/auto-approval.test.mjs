import assert from "node:assert/strict";
import test from "node:test";
import { claimAutoApproval } from "../app/lib/auto-approval.mjs";

const file = { id: "request-1", approvalType: "file", files: [{ path: "paper/main.tex" }] };

test("auto-approval requires opt-in and only claims complete file proposals", () => {
  const attempted = new Set();
  assert.equal(claimAutoApproval(file, false, false, attempted), false);
  assert.equal(claimAutoApproval(null, true, false, attempted), false);
  assert.equal(claimAutoApproval({ ...file, files: [] }, true, false, attempted), false);
  assert.equal(attempted.size, 0);
  assert.equal(claimAutoApproval(file, true, false, attempted), true);
});

test("permission grants and unknown request types always require manual approval", () => {
  const attempted = new Set();
  for (const approvalType of ["permission", "command", "future-type", undefined]) {
    assert.equal(claimAutoApproval({ ...file, approvalType }, true, false, attempted), false);
  }
  assert.equal(attempted.size, 0);
});

test("stream replay, status recovery and re-enabling cannot duplicate an automatic decision", () => {
  const attempted = new Set();
  assert.equal(claimAutoApproval(file, true, false, attempted), true);
  assert.equal(claimAutoApproval({ ...file }, true, false, attempted), false);
  assert.equal(claimAutoApproval(file, false, false, attempted), false);
  assert.equal(claimAutoApproval(file, true, false, attempted), false);
  assert.equal(claimAutoApproval({ ...file, id: "request-2" }, true, false, attempted), true);
});

test("in-flight writes, delayed confirmations and refreshes defer rather than consume the next proposal", () => {
  const attempted = new Set();
  assert.equal(claimAutoApproval(file, true, true, attempted), false);
  assert.equal(attempted.size, 0);
  assert.equal(claimAutoApproval(file, true, false, attempted), true);
});
