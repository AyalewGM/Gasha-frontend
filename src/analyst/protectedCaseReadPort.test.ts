import { describe, expect, it, vi } from "vitest";
import { createProtectedCaseReadPort } from "./protectedCaseReadPort";

const CASE = "abcdef11-1111-4111-8111-111111111111";

describe("injected protected case reads", () => {
  it("uses only tenant-bound relative paths for queue and history", async () => {
    const get = vi.fn()
      .mockResolvedValueOnce({ status: 200, payload: { items: [] } })
      .mockResolvedValueOnce({ status: 200, payload: { case_id: CASE } });
    const port = createProtectedCaseReadPort("synthetic-a", get);
    expect(get).not.toHaveBeenCalled();
    await expect(port.readQueue(25)).resolves.toEqual({ items: [] });
    await expect(port.readHistory(CASE)).resolves.toEqual({ case_id: CASE });
    expect(get.mock.calls).toEqual([
      ["/v1/tenants/synthetic-a/cases/queue?limit=25"],
      [`/v1/tenants/synthetic-a/cases/${CASE}/history`],
    ]);
  });

  it("rejects path switches and invalid limits before invoking the transport", async () => {
    const get = vi.fn();
    for (const tenant of ["", "../tenant-b", "a%2fb", "https://example.com", "a?query", "synthetic-a\n"]) {
      expect(() => createProtectedCaseReadPort(tenant, get)).toThrow("Protected case read unavailable");
    }
    const port = createProtectedCaseReadPort("synthetic-a", get);
    for (const limit of [0, 101, 1.5, NaN, Infinity]) {
      await expect(port.readQueue(limit)).rejects.toThrow("Protected case read unavailable");
    }
    for (const caseId of ["..", `${CASE}/history`, `${CASE}?tenant=tenant-b`, `${CASE}\n`, CASE.toUpperCase()]) {
      await expect(port.readHistory(caseId)).rejects.toThrow("Protected case read unavailable");
    }
    expect(get).not.toHaveBeenCalled();
  });

  it.each([403, 404, 503, 302])("redacts the response body for status %i", async (status) => {
    const get = vi.fn().mockResolvedValue({ status, payload: { detail: "sensitive server detail" } });
    const port = createProtectedCaseReadPort("synthetic-a", get);
    await expect(port.readQueue(25)).rejects.toMatchObject({
      message: "Protected case read unavailable",
      status: status === 302 ? null : status,
    });
  });

  it("redacts thrown transport diagnostics", async () => {
    const get = vi.fn().mockRejectedValue({ status: 401, message: "sensitive transport detail" });
    const port = createProtectedCaseReadPort("synthetic-a", get);
    await expect(port.readQueue(25)).rejects.toMatchObject({
      message: "Protected case read unavailable",
      status: null,
    });
  });

  it("blocks subsequent and late reads following the session's 401", async () => {
    let completeQueue!: (value: { status: number; payload: unknown }) => void;
    const queue = new Promise<{ status: number; payload: unknown }>((resolve) => {
      completeQueue = resolve;
    });
    const get = vi.fn().mockReturnValueOnce(queue).mockResolvedValueOnce({ status: 401 });
    const port = createProtectedCaseReadPort("synthetic-a", get);
    const pending = port.readQueue(25);
    await expect(port.readHistory(CASE)).rejects.toMatchObject({ status: 401 });
    completeQueue({ status: 200, payload: { items: [] } });
    await expect(pending).rejects.toMatchObject({ status: 401 });
    await expect(port.readQueue(25)).rejects.toMatchObject({ status: 401 });
    expect(get).toHaveBeenCalledTimes(2);
  });
});
