/**
 * ES-090 U2k — HP-241 gate-positioning regression guard (spec §c.1, PR#1 merge gate).
 *
 * HP-241 ordering invariant: inside `if (site.emailVerified)` (the re-login
 * branch of `POST /api/sites/[id]/verify`), the FIRST call to
 * `assertOtpGate(...)` must appear BEFORE the FIRST `db.update` / `db.insert`
 * / `db.delete` call. If a refactor reorders a consent-insert or a state-
 * pollution write BEFORE assertOtpGate, any caller with a siteId alone can
 * write rows without proving OTP possession.
 *
 * Uses the `typescript` compiler API to parse the route's source and walk the
 * AST of the `if (site.emailVerified) { ... }` then-branch. Static analysis
 * rather than runtime intercept — the invariant is a textual/positional
 * property of the source, not a dynamic behavior.
 *
 * Tolerates: no DB mutation in the branch at all (trivially held). Trips:
 * any `db.update(...)` / `db.insert(...)` / `db.delete(...)` whose start
 * position is earlier than the first `assertOtpGate(...)` call in the
 * branch body.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, it, expect } from "vitest";

describe("ES-090 U2k — HP-241 gate-positioning regression guard (PR#1 merge gate)", () => {
  it("first DB mutation inside `if (site.emailVerified)` appears AFTER the first assertOtpGate call", () => {
    const filePath = join(process.cwd(), "app/api/sites/[id]/verify/route.ts");
    const source = readFileSync(filePath, "utf-8");
    const sf = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, /* setParentNodes */ true);

    // Locate the then-branch of `if (site.emailVerified)`. Match by shape —
    // a PropertyAccessExpression with `name.text === "emailVerified"` and
    // `expression.text === "site"`. Resilient to reformatting.
    let branchBody: ts.Node | null = null;
    function visit(n: ts.Node): void {
      if (ts.isIfStatement(n)) {
        const cond = n.expression;
        if (
          ts.isPropertyAccessExpression(cond) &&
          cond.name.text === "emailVerified" &&
          ts.isIdentifier(cond.expression) &&
          cond.expression.text === "site"
        ) {
          branchBody = n.thenStatement;
        }
      }
      n.forEachChild(visit);
    }
    visit(sf);
    expect(
      branchBody,
      "HP-241 prerequisite: re-login branch `if (site.emailVerified)` must exist in verify/route.ts",
    ).not.toBeNull();

    // Walk the then-branch, recording:
    //   - the earliest position of any `assertOtpGate(...)` call
    //   - the earliest position of any `db.update(...)` / `db.insert(...)` / `db.delete(...)` call
    let assertOtpGatePos = Infinity;
    let firstDbMutationPos = Infinity;
    const mutationKinds = new Set(["update", "insert", "delete"]);

    function walk(n: ts.Node): void {
      if (ts.isCallExpression(n)) {
        const expr = n.expression;
        if (ts.isIdentifier(expr) && expr.text === "assertOtpGate") {
          assertOtpGatePos = Math.min(assertOtpGatePos, n.getStart());
        } else if (
          ts.isPropertyAccessExpression(expr) &&
          ts.isIdentifier(expr.expression) &&
          expr.expression.text === "db" &&
          mutationKinds.has(expr.name.text)
        ) {
          firstDbMutationPos = Math.min(firstDbMutationPos, n.getStart());
        }
      }
      n.forEachChild(walk);
    }
    walk(branchBody!);

    expect(
      assertOtpGatePos,
      "HP-241 invariant: assertOtpGate MUST be called in the re-login branch (`if (site.emailVerified)`). " +
      "Not finding it means the OTP precondition has been removed — a critical security regression.",
    ).toBeLessThan(Infinity);

    if (firstDbMutationPos !== Infinity) {
      expect(
        assertOtpGatePos,
        "HP-241 invariant: first DB mutation in re-login branch must appear AFTER assertOtpGate. " +
        `Found db.{update,insert,delete}(...) at source pos ${firstDbMutationPos}, assertOtpGate at pos ${assertOtpGatePos}. ` +
        "A regression here means a consent-insert / state-write / rotation is reachable before the OTP gate — " +
        "any caller with just a siteId could trigger row writes without proving email possession.",
      ).toBeLessThan(firstDbMutationPos);
    }
    // If no DB mutation is present in the branch, the invariant is trivially
    // held (no mutations to misorder).
  });
});
