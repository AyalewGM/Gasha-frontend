import { describe, expect, it } from "vitest";
import { findSyntheticScenario, SYNTHETIC_SCENARIOS } from "./syntheticScenarios";

describe("synthetic-only UC scenario fixtures", () => {
  it("includes three distinct reproducible scenario inputs", () => {
    expect(SYNTHETIC_SCENARIOS.map((scenario) => scenario.id)).toEqual(["uc01", "uc02", "uc03"]);
    expect(new Set(SYNTHETIC_SCENARIOS.map((s) => s.transaction.beneficiary_id)).size).toBe(3);
    expect(findSyntheticScenario("uc02")).toBe(SYNTHETIC_SCENARIOS[1]);
    expect(findSyntheticScenario("unrecognized")).toBeUndefined();
  });

  it("uses fake identifiers, no cross-bank state, and finite bounded illustrative risk values", () => {
    for (const scenario of SYNTHETIC_SCENARIOS) {
      const tx = scenario.transaction;
      expect(tx.tenant_id).toBe("synthetic-tenant");
      for (const id of [
        tx.sender_customer_id, tx.sender_account_id, tx.beneficiary_id,
        tx.destination_institution_id, tx.device_id,
      ]) expect(id.startsWith("synthetic-")).toBe(true);
      expect(tx.beneficiary_type).toBe("external");
      expect(Object.keys(scenario.risks)).toHaveLength(8);
      for (const risk of Object.values(scenario.risks)) {
        expect(Number.isFinite(risk)).toBe(true);
        expect(risk).toBeGreaterThanOrEqual(0);
        expect(risk).toBeLessThanOrEqual(1);
      }
    }
  });
});
