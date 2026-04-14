import express from "express";
import { Interface, isAddress } from "ethers";
import { z } from "zod";
import { complianceRegistry, distributionModule, oracleRouter, redemptionModule, servicedAssetToken, chainStatus } from "./chain.js";
import { buildDistributionTree } from "./merkle.js";
import { loadState, saveState } from "./store.js";
import { distributionModuleAbi, redemptionModuleAbi } from "./abis.js";
import { config } from "./config.js";

const investorProfileSchema = z.object({
  account: z.string().refine(isAddress, "invalid address"),
  approved: z.boolean(),
  accredited: z.boolean(),
  frozen: z.boolean().default(false),
  tier: z.number().int().min(0).max(255),
  jurisdiction: z.number().int().min(0),
  expiry: z.number().int().positive()
});

const snapshotSchema = z.object({
  label: z.string().min(1),
  payoutToken: z.string().refine(isAddress, "invalid payout token address"),
  snapshotTimestamp: z.number().int().positive(),
  metadataURI: z.string().min(1),
  allocations: z.array(
    z.object({
      account: z.string().refine(isAddress, "invalid account address"),
      assetAmount: z.string().refine((value) => BigInt(value) > 0n, "assetAmount must be positive"),
      payoutAmount: z.string().refine((value) => BigInt(value) > 0n, "payoutAmount must be positive")
    })
  ).min(1)
}).superRefine((value, ctx) => {
  const seen = new Set();

  for (const [index, allocation] of value.allocations.entries()) {
    const normalized = allocation.account.toLowerCase();
    if (seen.has(normalized)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "duplicate allocation account",
        path: ["allocations", index, "account"]
      });
    }
    seen.add(normalized);
  }
});

const publishDistributionSchema = z.object({
  nativeValue: z.string().optional()
});

const redemptionActionSchema = z.object({
  requestId: z.coerce.number().int().min(0)
});

const rejectionSchema = z.object({
  reason: z.string().min(1)
});

const jurisdictionSchema = z.object({
  jurisdiction: z.number().int().min(0),
  allowed: z.boolean()
});

const claimIntentSchema = z.object({
  account: z.string().refine(isAddress, "invalid address")
});

const redemptionIntentSchema = z.object({
  assetAmount: z.string(),
  payoutAmount: z.string(),
  memo: z.string().min(1)
});

const mintSchema = z.object({
  to: z.string().refine(isAddress, "invalid address"),
  amount: z.string().refine((value) => BigInt(value) > 0n, "amount must be positive")
});

const oracleQuoteSchema = z.object({
  asset: z.string().refine(isAddress, "invalid address"),
  assetAmount: z.string().refine((value) => BigInt(value) > 0n, "assetAmount must be positive"),
  feeBps: z.coerce.number().int().min(0).max(10_000).default(0),
  haircutBps: z.coerce.number().int().min(0).max(10_000).default(0)
});

const distributionInterface = new Interface(distributionModuleAbi);
const redemptionInterface = new Interface(redemptionModuleAbi);
const ORACLE_ERROR_MESSAGES = {
  "0x8e1409ba": "Oracle feed is not configured for this asset.",
  "0xa942746e": "Oracle feed is configured but currently disabled.",
  "0xeb1fe96e": "Oracle price is stale on the configured testnet feed.",
  "0xdcd07d4f": "Oracle returned an invalid price for this asset.",
  "0xc6cc5d7f": "Fee or haircut basis points are invalid."
};

function getDistributionCreatedId(receipt) {
  for (const log of receipt?.logs ?? []) {
    try {
      const parsed = distributionInterface.parseLog(log);
      if (parsed?.name === "DistributionCreated") {
        return Number(parsed.args.distributionId);
      }
    } catch {
      // ignore unrelated logs
    }
  }

  throw new Error("DistributionCreated event not found in transaction receipt");
}

function jsonSafe(value) {
  if (typeof value === "bigint") {
    return value.toString();
  }

  if (Array.isArray(value)) {
    return value.map(jsonSafe);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, innerValue]) => [key, jsonSafe(innerValue)])
    );
  }

  return value;
}

function requireAdmin(req, res, adminApiKey) {
  if (!adminApiKey) {
    return true;
  }

  if (req.header("x-admin-key") !== adminApiKey) {
    res.status(401).json({ error: "unauthorized" });
    return false;
  }

  return true;
}

function badRequest(message, details) {
  return { statusCode: 400, message, details };
}

function extractErrorData(error) {
  const candidates = [
    error?.data,
    error?.info?.error?.data,
    error?.error?.data,
    error?.revert?.data
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.startsWith("0x")) {
      return candidate;
    }
  }

  return null;
}

function humanizeOracleError(error) {
  const data = extractErrorData(error);
  const selector = data?.slice(0, 10);
  const message = selector ? ORACLE_ERROR_MESSAGES[selector] : null;

  if (!message) {
    return null;
  }

  return {
    statusCode: 400,
    message,
    details: {
      code: selector,
      raw: error?.message
    }
  };
}

function formatInvestorProfile(profile) {
  return {
    approved: profile.approved ?? profile[0],
    accredited: profile.accredited ?? profile[1],
    frozen: profile.frozen ?? profile[2],
    tier: jsonSafe(profile.tier ?? profile[3]),
    jurisdiction: jsonSafe(profile.jurisdiction ?? profile[4]),
    expiry: jsonSafe(profile.expiry ?? profile[5])
  };
}

function formatOracleQuote(quote) {
  return {
    grossUsdValue18: jsonSafe(quote.grossUsdValue18 ?? quote[0]),
    netUsdValue18: jsonSafe(quote.netUsdValue18 ?? quote[1]),
    answer: jsonSafe(quote.answer ?? quote[2]),
    feedDecimals: jsonSafe(quote.feedDecimals ?? quote[3]),
    updatedAt: jsonSafe(quote.updatedAt ?? quote[4])
  };
}

function formatRedemptionRequest(request) {
  return {
    investor: request.investor ?? request[0],
    assetAmount: jsonSafe(request.assetAmount ?? request[1]),
    payoutAmount: jsonSafe(request.payoutAmount ?? request[2]),
    requestedAt: jsonSafe(request.requestedAt ?? request[3]),
    updatedAt: jsonSafe(request.updatedAt ?? request[4]),
    status: jsonSafe(request.status ?? request[5]),
    memo: request.memo ?? request[6]
  };
}

export function createApp(options = {}) {
  const {
    services = {},
    stateStore = {}
  } = options;
  const adminApiKey = Object.hasOwn(options, "adminApiKey")
    ? options.adminApiKey
    : config.ADMIN_API_KEY;

  const activeComplianceRegistry = Object.hasOwn(services, "complianceRegistry")
    ? services.complianceRegistry
    : complianceRegistry;
  const activeDistributionModule = Object.hasOwn(services, "distributionModule")
    ? services.distributionModule
    : distributionModule;
  const activeOracleRouter = Object.hasOwn(services, "oracleRouter")
    ? services.oracleRouter
    : oracleRouter;
  const activeRedemptionModule = Object.hasOwn(services, "redemptionModule")
    ? services.redemptionModule
    : redemptionModule;
  const activeServicedAssetToken = Object.hasOwn(services, "servicedAssetToken")
    ? services.servicedAssetToken
    : servicedAssetToken;
  const getChainStatus = Object.hasOwn(services, "chainStatus")
    ? services.chainStatus
    : chainStatus;
  const readState = Object.hasOwn(stateStore, "loadState")
    ? stateStore.loadState
    : loadState;
  const writeState = Object.hasOwn(stateStore, "saveState")
    ? stateStore.saveState
    : saveState;

  const app = express();
  app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", config.CORS_ORIGIN);
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-admin-key");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");

    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }

    next();
  });
  app.use(express.json());

  app.get("/health", async (_req, res) => {
    res.json({
      ok: true,
      chain: getChainStatus()
    });
  });

  app.get("/oracle/redemption-quote", async (req, res, next) => {
    try {
      if (!activeOracleRouter) {
        return res.status(400).json({ error: "ORACLE_ROUTER_ADDRESS is not configured" });
      }

      const payload = oracleQuoteSchema.parse(req.query);
      const quote = await activeOracleRouter.getRedemptionQuote(
        payload.asset,
        payload.assetAmount,
        payload.feeBps,
        payload.haircutBps
      );

      res.json({
        asset: payload.asset,
        assetAmount: payload.assetAmount,
        feeBps: payload.feeBps,
        haircutBps: payload.haircutBps,
        quote: formatOracleQuote(quote)
      });
    } catch (error) {
      const friendlyOracleError = humanizeOracleError(error);
      if (friendlyOracleError) {
        return next(friendlyOracleError);
      }
      next(error);
    }
  });

  app.get("/investors/:account", async (req, res, next) => {
    try {
      if (!activeComplianceRegistry) {
        return res.status(400).json({ error: "COMPLIANCE_REGISTRY_ADDRESS is not configured" });
      }

      const [profile, eligible] = await Promise.all([
        activeComplianceRegistry.getInvestorProfile(req.params.account),
        activeComplianceRegistry.isWalletEligible(req.params.account)
      ]);

      res.json({ account: req.params.account, eligible, profile: formatInvestorProfile(profile) });
    } catch (error) {
      next(error);
    }
  });

  app.post("/admin/investors", async (req, res, next) => {
    try {
      if (!requireAdmin(req, res, adminApiKey)) {
        return;
      }

      if (!activeComplianceRegistry) {
        return res.status(400).json({ error: "COMPLIANCE_REGISTRY_ADDRESS is not configured" });
      }

      const payload = investorProfileSchema.parse(req.body);
      const tx = await activeComplianceRegistry.setInvestorProfile(
        payload.account,
        payload.approved,
        payload.accredited,
        payload.frozen,
        payload.tier,
        payload.jurisdiction,
        payload.expiry
      );

      await tx.wait();
      res.json({ ok: true, txHash: tx.hash });
    } catch (error) {
      next(error);
    }
  });

  app.post("/admin/jurisdictions", async (req, res, next) => {
    try {
      if (!requireAdmin(req, res, adminApiKey)) {
        return;
      }

      if (!activeComplianceRegistry) {
        return res.status(400).json({ error: "COMPLIANCE_REGISTRY_ADDRESS is not configured" });
      }

      const payload = jurisdictionSchema.parse(req.body);
      const tx = await activeComplianceRegistry.setAllowedJurisdiction(payload.jurisdiction, payload.allowed);
      await tx.wait();

      res.json({ ok: true, txHash: tx.hash });
    } catch (error) {
      next(error);
    }
  });

  app.post("/admin/snapshots", async (req, res, next) => {
    try {
      if (!requireAdmin(req, res, adminApiKey)) {
        return;
      }

      const payload = snapshotSchema.parse(req.body);
      const state = await readState();

      const snapshotId = state.snapshots.length;
      const tree = buildDistributionTree(payload.allocations);
      const snapshot = {
        id: snapshotId,
        label: payload.label,
        payoutToken: payload.payoutToken,
        snapshotTimestamp: payload.snapshotTimestamp,
        metadataURI: payload.metadataURI,
        root: tree.root,
        allocations: tree.claims
      };

      state.snapshots.push(snapshot);
      await writeState(state);

      res.json(snapshot);
    } catch (error) {
      next(error);
    }
  });

  app.get("/admin/snapshots", async (_req, res, next) => {
    try {
      const state = await readState();
      res.json({ snapshots: state.snapshots, distributions: state.distributions });
    } catch (error) {
      next(error);
    }
  });

  app.post("/admin/distributions/:snapshotId/publish", async (req, res, next) => {
    try {
      if (!requireAdmin(req, res, adminApiKey)) {
        return;
      }

      if (!activeDistributionModule) {
        return res.status(400).json({ error: "DISTRIBUTION_MODULE_ADDRESS is not configured" });
      }

      const publishPayload = publishDistributionSchema.parse(req.body ?? {});
      const snapshotId = Number(req.params.snapshotId);
      const state = await readState();
      const snapshot = state.snapshots.find((item) => item.id === snapshotId);

      if (!snapshot) {
        return res.status(404).json({ error: "snapshot not found" });
      }

      const totalAmount = snapshot.allocations.reduce(
        (sum, allocation) => sum + BigInt(allocation.payoutAmount),
        0n
      );
      const nativeSettlement = snapshot.payoutToken.toLowerCase() === "0x0000000000000000000000000000000000000000";
      const nativeValue = publishPayload.nativeValue ? BigInt(publishPayload.nativeValue) : totalAmount;

      if (nativeSettlement && nativeValue !== totalAmount) {
        throw badRequest("nativeValue must equal total payout amount", {
          expected: totalAmount.toString(),
          received: nativeValue.toString()
        });
      }

      const tx = await activeDistributionModule.createDistribution(
        snapshot.payoutToken,
        snapshot.root,
        totalAmount,
        snapshot.snapshotTimestamp,
        snapshot.metadataURI,
        {
          value: nativeSettlement ? nativeValue : 0n
        }
      );

      const receipt = await tx.wait();
      const distributionId = getDistributionCreatedId(receipt);

      state.distributions.push({
        distributionId,
        snapshotId,
        root: snapshot.root,
        txHash: tx.hash
      });
      await writeState(state);

      res.json({ ok: true, txHash: tx.hash, root: snapshot.root, totalAmount: totalAmount.toString() });
    } catch (error) {
      next(error);
    }
  });

  app.get("/admin/snapshots/:snapshotId", async (req, res, next) => {
    try {
      const snapshotId = Number(req.params.snapshotId);
      const state = await readState();
      const snapshot = state.snapshots.find((item) => item.id === snapshotId);

      if (!snapshot) {
        return res.status(404).json({ error: "snapshot not found" });
      }

      res.json(snapshot);
    } catch (error) {
      next(error);
    }
  });

  app.get("/admin/snapshots/:snapshotId/claims/:account", async (req, res, next) => {
    try {
      const snapshotId = Number(req.params.snapshotId);
      const state = await readState();
      const snapshot = state.snapshots.find((item) => item.id === snapshotId);

      if (!snapshot) {
        return res.status(404).json({ error: "snapshot not found" });
      }

      const claim = snapshot.allocations.find(
        (allocation) => allocation.account.toLowerCase() === req.params.account.toLowerCase()
      );

      if (!claim) {
        return res.status(404).json({ error: "claim not found for account" });
      }

      res.json({ snapshotId, claim });
    } catch (error) {
      next(error);
    }
  });

  app.post("/intents/distributions/:snapshotId/claim", async (req, res, next) => {
    try {
      if (!activeDistributionModule) {
        return res.status(400).json({ error: "DISTRIBUTION_MODULE_ADDRESS is not configured" });
      }

      const payload = claimIntentSchema.parse(req.body);
      const snapshotId = Number(req.params.snapshotId);
      const state = await readState();
      const snapshot = state.snapshots.find((item) => item.id === snapshotId);

      if (!snapshot) {
        return res.status(404).json({ error: "snapshot not found" });
      }

      const claim = snapshot.allocations.find(
        (allocation) => allocation.account.toLowerCase() === payload.account.toLowerCase()
      );

      if (!claim) {
        return res.status(404).json({ error: "claim not found for account" });
      }

      const distributionRecord = state.distributions.find((item) => item.snapshotId === snapshotId);
      if (!distributionRecord) {
        return res.status(404).json({ error: "snapshot has not been published on-chain" });
      }

      const data = distributionInterface.encodeFunctionData("claim", [
        distributionRecord.distributionId,
        claim.assetAmount,
        claim.payoutAmount,
        claim.proof
      ]);

      res.json({
        target: activeDistributionModule.target,
        data,
        value: "0",
        distributionId: distributionRecord.distributionId,
        claim
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/assets/:account", async (req, res, next) => {
    try {
      if (!activeServicedAssetToken) {
        return res.status(400).json({ error: "SERVICED_ASSET_TOKEN_ADDRESS is not configured" });
      }

      const [balance, totalSupply] = await Promise.all([
        activeServicedAssetToken.balanceOf(req.params.account),
        activeServicedAssetToken.totalSupply()
      ]);

      res.json({
        account: req.params.account,
        balance: balance.toString(),
        totalSupply: totalSupply.toString()
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/admin/assets/mint", async (req, res, next) => {
    try {
      if (!requireAdmin(req, res, adminApiKey)) {
        return;
      }

      if (!activeServicedAssetToken) {
        return res.status(400).json({ error: "SERVICED_ASSET_TOKEN_ADDRESS is not configured" });
      }

      const payload = mintSchema.parse(req.body);
      const tx = await activeServicedAssetToken.mint(payload.to, payload.amount);
      await tx.wait();

      res.json({ ok: true, txHash: tx.hash });
    } catch (error) {
      next(error);
    }
  });

  app.post("/redemptions/:requestId/approve", async (req, res, next) => {
    try {
      if (!requireAdmin(req, res, adminApiKey)) {
        return;
      }

      if (!activeRedemptionModule) {
        return res.status(400).json({ error: "REDEMPTION_MODULE_ADDRESS is not configured" });
      }

      const { requestId } = redemptionActionSchema.parse(req.params);
      const tx = await activeRedemptionModule.approveRequest(requestId);
      await tx.wait();

      res.json({ ok: true, txHash: tx.hash });
    } catch (error) {
      next(error);
    }
  });

  app.post("/redemptions/:requestId/reject", async (req, res, next) => {
    try {
      if (!requireAdmin(req, res, adminApiKey)) {
        return;
      }

      if (!activeRedemptionModule) {
        return res.status(400).json({ error: "REDEMPTION_MODULE_ADDRESS is not configured" });
      }

      const { requestId } = redemptionActionSchema.parse(req.params);
      const payload = rejectionSchema.parse(req.body);
      const tx = await activeRedemptionModule.rejectRequest(requestId, payload.reason);
      await tx.wait();

      res.json({ ok: true, txHash: tx.hash });
    } catch (error) {
      next(error);
    }
  });

  app.post("/redemptions/:requestId/settle", async (req, res, next) => {
    try {
      if (!requireAdmin(req, res, adminApiKey)) {
        return;
      }

      if (!activeRedemptionModule) {
        return res.status(400).json({ error: "REDEMPTION_MODULE_ADDRESS is not configured" });
      }

      const { requestId } = redemptionActionSchema.parse(req.params);
      const tx = await activeRedemptionModule.settleRequest(requestId);
      await tx.wait();

      res.json({ ok: true, txHash: tx.hash });
    } catch (error) {
      next(error);
    }
  });

  app.get("/redemptions/:requestId", async (req, res, next) => {
    try {
      if (!activeRedemptionModule) {
        return res.status(400).json({ error: "REDEMPTION_MODULE_ADDRESS is not configured" });
      }

      const { requestId } = redemptionActionSchema.parse(req.params);
      const request = await activeRedemptionModule.getRequest(requestId);
      res.json({ requestId, request: formatRedemptionRequest(request) });
    } catch (error) {
      next(error);
    }
  });

  app.post("/intents/redemptions/request", async (req, res, next) => {
    try {
      if (!activeRedemptionModule) {
        return res.status(400).json({ error: "REDEMPTION_MODULE_ADDRESS is not configured" });
      }

      const payload = redemptionIntentSchema.parse(req.body);
      const data = redemptionInterface.encodeFunctionData("requestRedemption", [
        payload.assetAmount,
        payload.payoutAmount,
        payload.memo
      ]);

      res.json({
        target: activeRedemptionModule.target,
        data,
        value: "0"
      });
    } catch (error) {
      next(error);
    }
  });

  app.use((error, _req, res, _next) => {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        error: "validation failed",
        details: error.issues
      });
    }

    if (typeof error?.statusCode === "number") {
      return res.status(error.statusCode).json({
        error: error.message || "request failed",
        details: error.details
      });
    }

    const message = error?.message || "internal error";
    res.status(500).json({ error: message });
  });

  return app;
}
