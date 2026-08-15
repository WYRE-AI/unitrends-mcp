/**
 * Real handler-invocation tests for handleUnitrendsTool.
 * Mocks the UnitrendsClient SDK, elicitation, and the card builder so these
 * exercise the tool-handler's own logic (credential gating, request shaping,
 * response mapping, error handling) rather than any real network call.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const {
  mockAppliancesList,
  mockAppliancesListAll,
  mockAssetsList,
  mockAssetsGet,
  mockJobsListBackups,
  mockJobsListHistory,
  mockRecoveryPointsList,
  mockRestoresQueue,
  mockRestoresGet,
  mockAlertsList,
  mockReportsSuccessRate,
  mockClient,
} = vi.hoisted(() => {
  const mockAppliancesList = vi.fn();
  const mockAppliancesListAll = vi.fn();
  const mockAssetsList = vi.fn();
  const mockAssetsGet = vi.fn();
  const mockJobsListBackups = vi.fn();
  const mockJobsListHistory = vi.fn();
  const mockRecoveryPointsList = vi.fn();
  const mockRestoresQueue = vi.fn();
  const mockRestoresGet = vi.fn();
  const mockAlertsList = vi.fn();
  const mockReportsSuccessRate = vi.fn();
  const mockClient = {
    appliances: { list: mockAppliancesList, listAll: mockAppliancesListAll },
    assets: { list: mockAssetsList, get: mockAssetsGet },
    jobs: { listBackups: mockJobsListBackups, listHistory: mockJobsListHistory },
    recoveryPoints: { list: mockRecoveryPointsList },
    restores: { queue: mockRestoresQueue, get: mockRestoresGet },
    alerts: { list: mockAlertsList },
    reports: { successRate: mockReportsSuccessRate },
  };
  return {
    mockAppliancesList,
    mockAppliancesListAll,
    mockAssetsList,
    mockAssetsGet,
    mockJobsListBackups,
    mockJobsListHistory,
    mockRecoveryPointsList,
    mockRestoresQueue,
    mockRestoresGet,
    mockAlertsList,
    mockReportsSuccessRate,
    mockClient,
  };
});

vi.mock("@wyre-technology/node-unitrends", () => ({
  UnitrendsClient: vi.fn().mockImplementation(function UnitrendsClient() {
    return mockClient;
  }),
}));

const { mockElicitConfirmation, mockElicitSelection, mockElicitText } = vi.hoisted(() => ({
  mockElicitConfirmation: vi.fn(),
  mockElicitSelection: vi.fn(),
  mockElicitText: vi.fn(),
}));
vi.mock("../src/utils/elicitation.js", () => ({
  elicitConfirmation: mockElicitConfirmation,
  elicitSelection: mockElicitSelection,
  elicitText: mockElicitText,
}));

const { mockBuildApplianceCard } = vi.hoisted(() => ({
  mockBuildApplianceCard: vi.fn(),
}));
vi.mock("../src/appliance-card.js", () => ({
  buildApplianceCard: mockBuildApplianceCard,
}));

import {
  handleUnitrendsTool,
  resolveDateRange,
  resolveApplianceId,
  findAppliance,
} from "../src/tool-handler.js";

/** Build a real async generator so `for await` over appliances.listAll() works. */
async function* toAsyncGen<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) yield item;
}

const CREDS = { baseUrl: "https://appliance.example", username: "admin", password: "secret" };

describe("handleUnitrendsTool", () => {
  beforeEach(() => {
    mockAppliancesList.mockReset();
    mockAppliancesListAll.mockReset();
    mockAssetsList.mockReset();
    mockAssetsGet.mockReset();
    mockJobsListBackups.mockReset();
    mockJobsListHistory.mockReset();
    mockRecoveryPointsList.mockReset();
    mockRestoresQueue.mockReset();
    mockRestoresGet.mockReset();
    mockAlertsList.mockReset();
    mockReportsSuccessRate.mockReset();
    mockElicitConfirmation.mockReset();
    mockElicitSelection.mockReset();
    mockElicitText.mockReset();
    mockBuildApplianceCard.mockReset();
    mockBuildApplianceCard.mockReturnValue(null);
  });

  describe("credential gating", () => {
    it("returns an error when creds is null", async () => {
      const result = await handleUnitrendsTool("unitrends_list_appliances", {}, null);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("No Unitrends credentials provided");
      expect(mockAppliancesList).not.toHaveBeenCalled();
    });
  });

  describe("unitrends_list_appliances", () => {
    it("lists appliances", async () => {
      mockAppliancesList.mockResolvedValueOnce([{ id: "a1" }]);
      const result = await handleUnitrendsTool("unitrends_list_appliances", {}, CREDS);

      expect(result.isError).toBeUndefined();
      expect(JSON.parse(result.content[0].text)).toEqual([{ id: "a1" }]);
    });

    it("returns an empty array when the API returns nullish", async () => {
      mockAppliancesList.mockResolvedValueOnce(undefined);
      const result = await handleUnitrendsTool("unitrends_list_appliances", {}, CREDS);

      expect(JSON.parse(result.content[0].text)).toEqual([]);
    });
  });

  describe("unitrends_get_appliance", () => {
    it("attaches a _card field when buildApplianceCard returns one", async () => {
      mockAppliancesListAll.mockReturnValueOnce(toAsyncGen([{ id: "a1", name: "Alpha" }]));
      mockBuildApplianceCard.mockReturnValueOnce({ applianceId: "a1", name: "Alpha" });

      const result = await handleUnitrendsTool(
        "unitrends_get_appliance",
        { applianceId: "a1" },
        CREDS
      );

      // buildApplianceCard is called with the SAME appliance object the
      // handler later spreads into the response payload, so assert on shape
      // rather than a snapshot taken after any downstream mutation.
      expect(mockBuildApplianceCard).toHaveBeenCalledWith(
        expect.objectContaining({ id: "a1", name: "Alpha" })
      );
      const data = JSON.parse(result.content[0].text);
      expect(data._card).toEqual({ applianceId: "a1", name: "Alpha" });
      expect(result.isError).toBeUndefined();
    });

    it("omits _card entirely when buildApplianceCard returns null", async () => {
      mockAppliancesListAll.mockReturnValueOnce(toAsyncGen([{ id: "a1" }]));

      const result = await handleUnitrendsTool(
        "unitrends_get_appliance",
        { applianceId: "a1" },
        CREDS
      );

      const data = JSON.parse(result.content[0].text);
      expect(data._card).toBeUndefined();
    });

    it("returns a not-found error when no appliance matches the id", async () => {
      mockAppliancesListAll.mockReturnValueOnce(toAsyncGen([{ id: "other" }]));

      const result = await handleUnitrendsTool(
        "unitrends_get_appliance",
        { applianceId: "missing" },
        CREDS
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Appliance missing not found");
      expect(mockBuildApplianceCard).not.toHaveBeenCalled();
    });
  });

  describe("unitrends_list_assets", () => {
    it("uses the provided applianceId without listing all appliances", async () => {
      mockAssetsList.mockResolvedValueOnce([{ id: "asset1" }]);

      const result = await handleUnitrendsTool(
        "unitrends_list_assets",
        { applianceId: "a1" },
        CREDS
      );

      expect(mockAppliancesList).not.toHaveBeenCalled();
      expect(mockAssetsList).toHaveBeenCalledWith({ applianceId: "a1" });
      expect(JSON.parse(result.content[0].text)).toEqual([{ id: "asset1" }]);
    });

    it("auto-resolves a single appliance without eliciting", async () => {
      mockAppliancesList.mockResolvedValueOnce([{ id: "only-one" }]);
      mockAssetsList.mockResolvedValueOnce([]);

      await handleUnitrendsTool("unitrends_list_assets", {}, CREDS);

      expect(mockElicitSelection).not.toHaveBeenCalled();
      expect(mockAssetsList).toHaveBeenCalledWith({ applianceId: "only-one" });
    });

    it("elicits a choice when multiple appliances exist and applianceId is omitted", async () => {
      mockAppliancesList.mockResolvedValueOnce([{ id: "a1" }, { id: "a2", name: "Beta" }]);
      mockElicitSelection.mockResolvedValueOnce("a2");
      mockAssetsList.mockResolvedValueOnce([]);

      await handleUnitrendsTool("unitrends_list_assets", {}, CREDS);

      expect(mockElicitSelection).toHaveBeenCalledTimes(1);
      expect(mockAssetsList).toHaveBeenCalledWith({ applianceId: "a2" });
    });

    it("calls assets.list with no applianceId filter when resolution yields none", async () => {
      mockAppliancesList.mockResolvedValueOnce([]);
      mockAssetsList.mockResolvedValueOnce([]);

      await handleUnitrendsTool("unitrends_list_assets", {}, CREDS);

      expect(mockAssetsList).toHaveBeenCalledWith({});
    });
  });

  describe("unitrends_get_asset", () => {
    it("fetches an asset by appliance + asset id", async () => {
      mockAssetsGet.mockResolvedValueOnce({ id: "asset1", name: "Server1" });

      const result = await handleUnitrendsTool(
        "unitrends_get_asset",
        { applianceId: "a1", assetId: "asset1" },
        CREDS
      );

      expect(mockAssetsGet).toHaveBeenCalledWith("a1", "asset1");
      expect(JSON.parse(result.content[0].text)).toEqual({ id: "asset1", name: "Server1" });
    });
  });

  describe("unitrends_list_running_jobs", () => {
    it("lists running/queued jobs", async () => {
      mockJobsListBackups.mockResolvedValueOnce([{ id: "job1" }]);
      const result = await handleUnitrendsTool("unitrends_list_running_jobs", {}, CREDS);

      expect(JSON.parse(result.content[0].text)).toEqual([{ id: "job1" }]);
    });
  });

  describe("unitrends_list_job_history", () => {
    it("skips elicitation when since/until are explicit", async () => {
      mockJobsListHistory.mockResolvedValueOnce([]);

      await handleUnitrendsTool(
        "unitrends_list_job_history",
        { since: "2026-01-01T00:00:00Z", until: "2026-01-31T00:00:00Z" },
        CREDS
      );

      expect(mockElicitSelection).not.toHaveBeenCalled();
      expect(mockJobsListHistory).toHaveBeenCalledWith();
    });

    it("elicits a window when no range is given", async () => {
      mockElicitSelection.mockResolvedValueOnce("all");
      mockJobsListHistory.mockResolvedValueOnce([]);

      await handleUnitrendsTool("unitrends_list_job_history", {}, CREDS);

      expect(mockElicitSelection).toHaveBeenCalledTimes(1);
      expect(mockJobsListHistory).toHaveBeenCalledWith();
    });
  });

  describe("unitrends_list_recovery_points", () => {
    it("lists recovery points for an asset", async () => {
      mockRecoveryPointsList.mockResolvedValueOnce([{ id: "rp1" }]);

      const result = await handleUnitrendsTool(
        "unitrends_list_recovery_points",
        { assetId: "asset1" },
        CREDS
      );

      expect(mockRecoveryPointsList).toHaveBeenCalledWith({ assetId: "asset1", applianceId: undefined });
      expect(JSON.parse(result.content[0].text)).toEqual([{ id: "rp1" }]);
    });
  });

  describe("unitrends_queue_restore", () => {
    const args = { recoveryPointId: "rp1", targetAssetId: "asset2", targetPath: "/restore" };

    it("queues the restore when the user confirms", async () => {
      mockElicitConfirmation.mockResolvedValueOnce(true);
      mockRestoresQueue.mockResolvedValueOnce({ restoreId: "r1" });

      const result = await handleUnitrendsTool("unitrends_queue_restore", args, CREDS);

      expect(mockElicitConfirmation).toHaveBeenCalledTimes(1);
      expect(mockRestoresQueue).toHaveBeenCalledWith({
        recoveryPointId: "rp1",
        targetAssetId: "asset2",
        targetPath: "/restore",
      });
      expect(result.isError).toBeUndefined();
      expect(JSON.parse(result.content[0].text)).toEqual({ restoreId: "r1" });
    });

    it("cancels without calling the API when the user declines", async () => {
      mockElicitConfirmation.mockResolvedValueOnce(false);

      const result = await handleUnitrendsTool("unitrends_queue_restore", args, CREDS);

      expect(mockRestoresQueue).not.toHaveBeenCalled();
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("cancelled by user");
    });

    it("cancels with a distinct message when the client can't elicit at all", async () => {
      mockElicitConfirmation.mockResolvedValueOnce(null);

      const result = await handleUnitrendsTool("unitrends_queue_restore", args, CREDS);

      expect(mockRestoresQueue).not.toHaveBeenCalled();
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("does not support confirmation prompts");
    });
  });

  describe("unitrends_get_restore_status", () => {
    it("fetches restore status by id", async () => {
      mockRestoresGet.mockResolvedValueOnce({ status: "completed" });
      const result = await handleUnitrendsTool(
        "unitrends_get_restore_status",
        { restoreId: "r1" },
        CREDS
      );

      expect(mockRestoresGet).toHaveBeenCalledWith("r1");
      expect(JSON.parse(result.content[0].text)).toEqual({ status: "completed" });
    });
  });

  describe("unitrends_list_alerts", () => {
    it("lists open alerts", async () => {
      mockAlertsList.mockResolvedValueOnce([{ id: "al1" }]);
      const result = await handleUnitrendsTool("unitrends_list_alerts", {}, CREDS);

      expect(JSON.parse(result.content[0].text)).toEqual([{ id: "al1" }]);
    });
  });

  describe("unitrends_get_success_rate", () => {
    it("converts an explicit ISO range to epoch seconds", async () => {
      mockReportsSuccessRate.mockResolvedValueOnce({ rate: 0.99 });

      await handleUnitrendsTool(
        "unitrends_get_success_rate",
        { since: "2026-01-01T00:00:00Z", until: "2026-01-02T00:00:00Z" },
        CREDS
      );

      expect(mockReportsSuccessRate).toHaveBeenCalledWith({
        startTime: Math.floor(new Date("2026-01-01T00:00:00Z").getTime() / 1000),
        endTime: Math.floor(new Date("2026-01-02T00:00:00Z").getTime() / 1000),
      });
    });

    it("passes undefined start/end when the resolved range is unbounded", async () => {
      mockElicitSelection.mockResolvedValueOnce("all");
      mockReportsSuccessRate.mockResolvedValueOnce({ rate: 1 });

      await handleUnitrendsTool("unitrends_get_success_rate", {}, CREDS);

      expect(mockReportsSuccessRate).toHaveBeenCalledWith({ startTime: undefined, endTime: undefined });
    });
  });

  describe("unknown tool", () => {
    it("returns an error for an unrecognized tool name", async () => {
      const result = await handleUnitrendsTool("unitrends_bogus", {}, CREDS);

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Unknown tool: unitrends_bogus");
    });
  });

  describe("error handling", () => {
    it("wraps a thrown error generically", async () => {
      mockAppliancesList.mockRejectedValueOnce(new Error("Unitrends API 500"));

      const result = await handleUnitrendsTool("unitrends_list_appliances", {}, CREDS);

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe("Error: Unitrends API 500");
    });

    it("stringifies a non-Error throw", async () => {
      mockAppliancesList.mockRejectedValueOnce("boom");

      const result = await handleUnitrendsTool("unitrends_list_appliances", {}, CREDS);

      expect(result.content[0].text).toBe("Error: boom");
    });
  });
});

describe("resolveDateRange", () => {
  beforeEach(() => {
    mockElicitSelection.mockReset();
    mockElicitText.mockReset();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-15T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns args unchanged when since is already set", async () => {
    const result = await resolveDateRange({ since: "2026-01-01T00:00:00Z" });
    expect(result).toEqual({ since: "2026-01-01T00:00:00Z" });
    expect(mockElicitSelection).not.toHaveBeenCalled();
  });

  it("returns args unchanged when until is already set", async () => {
    const result = await resolveDateRange({ until: "2026-01-01T00:00:00Z" });
    expect(result).toEqual({ until: "2026-01-01T00:00:00Z" });
  });

  it("returns an empty range when the user picks 'all'", async () => {
    mockElicitSelection.mockResolvedValueOnce("all");
    expect(await resolveDateRange({})).toEqual({});
  });

  it("returns an empty range when elicitation yields null (client can't elicit)", async () => {
    mockElicitSelection.mockResolvedValueOnce(null);
    expect(await resolveDateRange({})).toEqual({});
  });

  it("resolves a 24h preset relative to now", async () => {
    mockElicitSelection.mockResolvedValueOnce("24h");
    const result = await resolveDateRange({});
    expect(result).toEqual({ since: new Date("2026-06-14T12:00:00Z").toISOString() });
    expect(result.until).toBeUndefined();
  });

  it("resolves a 7d preset relative to now", async () => {
    mockElicitSelection.mockResolvedValueOnce("7d");
    const result = await resolveDateRange({});
    expect(result).toEqual({ since: new Date("2026-06-08T12:00:00Z").toISOString() });
  });

  it("resolves a 30d preset relative to now", async () => {
    mockElicitSelection.mockResolvedValueOnce("30d");
    const result = await resolveDateRange({});
    expect(result).toEqual({ since: new Date("2026-05-16T12:00:00Z").toISOString() });
  });

  it("prompts for custom since/until text when 'custom' is chosen", async () => {
    mockElicitSelection.mockResolvedValueOnce("custom");
    mockElicitText.mockResolvedValueOnce("2026-02-01T00:00:00Z");
    mockElicitText.mockResolvedValueOnce("2026-02-28T00:00:00Z");

    const result = await resolveDateRange({});

    expect(mockElicitText).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ since: "2026-02-01T00:00:00Z", until: "2026-02-28T00:00:00Z" });
  });

  it("treats a null custom until as omitted", async () => {
    mockElicitSelection.mockResolvedValueOnce("custom");
    mockElicitText.mockResolvedValueOnce("2026-02-01T00:00:00Z");
    mockElicitText.mockResolvedValueOnce(null);

    const result = await resolveDateRange({});
    expect(result).toEqual({ since: "2026-02-01T00:00:00Z", until: undefined });
  });
});

describe("resolveApplianceId", () => {
  beforeEach(() => {
    mockAppliancesList.mockReset();
    mockElicitSelection.mockReset();
  });

  it("returns the provided id without calling the API", async () => {
    const result = await resolveApplianceId(mockClient as never, "given-id");
    expect(result).toBe("given-id");
    expect(mockAppliancesList).not.toHaveBeenCalled();
  });

  it("returns undefined when the appliance list is empty", async () => {
    mockAppliancesList.mockResolvedValueOnce([]);
    expect(await resolveApplianceId(mockClient as never)).toBeUndefined();
  });

  it("auto-picks the single appliance without eliciting", async () => {
    mockAppliancesList.mockResolvedValueOnce([{ id: "solo" }]);
    expect(await resolveApplianceId(mockClient as never)).toBe("solo");
    expect(mockElicitSelection).not.toHaveBeenCalled();
  });

  it("unwraps a {items: [...]} response the same as a bare array", async () => {
    mockAppliancesList.mockResolvedValueOnce({ items: [{ id: "solo" }] });
    expect(await resolveApplianceId(mockClient as never)).toBe("solo");
  });

  it("elicits a selection among multiple appliances", async () => {
    mockAppliancesList.mockResolvedValueOnce([{ id: "a1" }, { id: "a2", name: "Beta" }]);
    mockElicitSelection.mockResolvedValueOnce("a2");
    expect(await resolveApplianceId(mockClient as never)).toBe("a2");
  });

  it("returns undefined when the API call throws", async () => {
    mockAppliancesList.mockRejectedValueOnce(new Error("network down"));
    expect(await resolveApplianceId(mockClient as never)).toBeUndefined();
  });
});

describe("findAppliance", () => {
  beforeEach(() => {
    mockAppliancesListAll.mockReset();
  });

  it("returns the matching appliance", async () => {
    mockAppliancesListAll.mockReturnValueOnce(
      toAsyncGen([{ id: "a1" }, { id: "a2", name: "Beta" }])
    );
    const result = await findAppliance(mockClient as never, "a2");
    expect(result).toEqual({ id: "a2", name: "Beta" });
  });

  it("returns undefined when no appliance matches", async () => {
    mockAppliancesListAll.mockReturnValueOnce(toAsyncGen([{ id: "a1" }]));
    const result = await findAppliance(mockClient as never, "missing");
    expect(result).toBeUndefined();
  });
});
