import test from "node:test";
import assert from "node:assert/strict";
import inject from "light-my-request";
import { Interface } from "ethers";
import { createApp } from "../src/app.js";

const distributionInterface = new Interface([
  "event DistributionCreated(uint256 indexed distributionId,address indexed payoutToken,bytes32 merkleRoot,uint128 totalAmount,uint64 snapshotTimestamp,string metadataURI)"
]);

function tx(hash = "0xtesthash", receipt = { hash, logs: [] }) {
  return {
    hash,
    wait: async () => receipt
  };
}

function createStateStore() {
  const state = {
    distributions: [],
    snapshots: [],
    redemptions: []
  };

  return {
    state,
    loadState: async () => structuredClone(state),
    saveState: async (nextState) => {
      state.distributions = structuredClone(nextState.distributions);
      state.snapshots = structuredClone(nextState.snapshots);
      state.redemptions = structuredClone(nextState.redemptions);
    }
  };
}

async function jsonRequest(app, options) {
  const response = await inject(app, options);
  return {
    statusCode: response.statusCode,
    body: response.body ? JSON.parse(response.body) : null
  };
}

test("backend health and admin flows work end to end", async () => {
  const store = createStateStore();
  const calls = {
    profiles: [],
    jurisdictions: [],
    mints: [],
    distributions: []
  };

  const services = {
    chainStatus: () => ({
      rpcUrl: "https://testnet.hsk.xyz",
      chainId: 133,
      hasSigner: true,
      hasComplianceRegistry: true,
      hasDistributionModule: true,
      hasRedemptionModule: true,
      hasServicedAssetToken: true
    }),
    complianceRegistry: {
      async getInvestorProfile(account) {
        return {
          approved: true,
          accredited: true,
          frozen: false,
          tier: 3,
          jurisdiction: 344,
          expiry: 1999999999,
          account
        };
      },
      async isWalletEligible() {
        return true;
      },
      async setInvestorProfile(...args) {
        calls.profiles.push(args);
        return tx("0xprofile");
      },
      async setAllowedJurisdiction(...args) {
        calls.jurisdictions.push(args);
        return tx("0xjurisdiction");
      }
    },
    distributionModule: {
      target: "0xdistribution",
      async createDistribution(...args) {
        calls.distributions.push(args);
        return tx("0xdistributiontx", {
          hash: "0xdistributiontx",
          logs: [
            distributionInterface.encodeEventLog(
              distributionInterface.getEvent("DistributionCreated"),
              [
                11n,
                args[0],
                args[1],
                BigInt(args[2]),
                BigInt(args[3]),
                args[4]
              ]
            )
          ]
        });
      }
    },
    oracleRouter: {
      async getRedemptionQuote() {
        return {
          grossUsdValue18: 100000000000000000000n,
          netUsdValue18: 98000000000000000000n,
          answer: 100000000n,
          feedDecimals: 8,
          updatedAt: 1717171717n
        };
      }
    },
    redemptionModule: {
      target: "0xredemption",
      async getRequest(requestId) {
        return {
          investor: "0x1111111111111111111111111111111111111111",
          assetAmount: 100n,
          payoutAmount: 90n,
          requestedAt: 1n,
          updatedAt: 2n,
          status: 1n,
          memo: `memo-${requestId}`
        };
      },
      async approveRequest() {
        return tx("0xapprove");
      },
      async rejectRequest() {
        return tx("0xreject");
      },
      async settleRequest() {
        return tx("0xsettle");
      }
    },
    servicedAssetToken: {
      async balanceOf() {
        return 500n;
      },
      async totalSupply() {
        return 1000n;
      },
      async mint(...args) {
        calls.mints.push(args);
        return tx("0xmint");
      }
    }
  };

  const app = createApp({
    adminApiKey: undefined,
    services,
    stateStore: {
      loadState: store.loadState,
      saveState: store.saveState
    }
  });

  const health = await jsonRequest(app, { method: "GET", url: "/health" });
  assert.equal(health.statusCode, 200);
  assert.equal(health.body.ok, true);
  assert.equal(health.body.chain.chainId, 133);

  const oracleQuote = await jsonRequest(app, {
    method: "GET",
    url: "/oracle/redemption-quote?asset=0x59E0f69FF6d25b5ceE757c874adAdC42E9857f2A&assetAmount=1000000000000000000&feeBps=50&haircutBps=150"
  });
  assert.equal(oracleQuote.statusCode, 200);
  assert.equal(oracleQuote.body.quote.netUsdValue18, "98000000000000000000");

  const investorWrite = await jsonRequest(app, {
    method: "POST",
    url: "/admin/investors",
    payload: {
      account: "0x1111111111111111111111111111111111111111",
      approved: true,
      accredited: true,
      frozen: false,
      tier: 3,
      jurisdiction: 344,
      expiry: 1999999999
    }
  });
  assert.equal(investorWrite.statusCode, 200);
  assert.equal(calls.profiles.length, 1);

  const jurisdictionWrite = await jsonRequest(app, {
    method: "POST",
    url: "/admin/jurisdictions",
    payload: { jurisdiction: 344, allowed: true }
  });
  assert.equal(jurisdictionWrite.statusCode, 200);
  assert.deepEqual(calls.jurisdictions[0], [344, true]);

  const mintWrite = await jsonRequest(app, {
    method: "POST",
    url: "/admin/assets/mint",
    payload: { to: "0x1111111111111111111111111111111111111111", amount: "1000" }
  });
  assert.equal(mintWrite.statusCode, 200);
  assert.deepEqual(calls.mints[0], ["0x1111111111111111111111111111111111111111", "1000"]);

  const snapshot = await jsonRequest(app, {
    method: "POST",
    url: "/admin/snapshots",
    payload: {
      label: "epoch-1",
      payoutToken: "0x0000000000000000000000000000000000000000",
      snapshotTimestamp: 1717171717,
      metadataURI: "ipfs://snapshot-1",
      allocations: [
        {
          account: "0x1111111111111111111111111111111111111111",
          assetAmount: "600",
          payoutAmount: "60"
        },
        {
          account: "0x2222222222222222222222222222222222222222",
          assetAmount: "400",
          payoutAmount: "40"
        }
      ]
    }
  });
  assert.equal(snapshot.statusCode, 200);
  assert.equal(snapshot.body.id, 0);
  assert.equal(store.state.snapshots.length, 1);

  const published = await jsonRequest(app, {
    method: "POST",
    url: "/admin/distributions/0/publish",
    payload: { nativeValue: "100" }
  });
  assert.equal(published.statusCode, 200);
  assert.equal(published.body.txHash, "0xdistributiontx");
  assert.equal(store.state.distributions[0].distributionId, 11);
  assert.equal(calls.distributions[0][0], "0x0000000000000000000000000000000000000000");
  assert.equal(calls.distributions[0][5].value, 100n);

  const claim = await jsonRequest(app, {
    method: "GET",
    url: "/admin/snapshots/0/claims/0x1111111111111111111111111111111111111111"
  });
  assert.equal(claim.statusCode, 200);
  assert.equal(claim.body.claim.payoutAmount, "60");

  const claimIntent = await jsonRequest(app, {
    method: "POST",
    url: "/intents/distributions/0/claim",
    payload: { account: "0x1111111111111111111111111111111111111111" }
  });
  assert.equal(claimIntent.statusCode, 200);
  assert.equal(claimIntent.body.target, "0xdistribution");
  assert.equal(claimIntent.body.distributionId, 11);

  const listedSnapshots = await jsonRequest(app, {
    method: "GET",
    url: "/admin/snapshots"
  });
  assert.equal(listedSnapshots.statusCode, 200);
  assert.equal(listedSnapshots.body.snapshots.length, 1);

  const redemptionIntent = await jsonRequest(app, {
    method: "POST",
    url: "/intents/redemptions/request",
    payload: { assetAmount: "100", payoutAmount: "90", memo: "window-1" }
  });
  assert.equal(redemptionIntent.statusCode, 200);
  assert.equal(redemptionIntent.body.target, "0xredemption");

  const investor = await jsonRequest(app, {
    method: "GET",
    url: "/investors/0x1111111111111111111111111111111111111111"
  });
  assert.equal(investor.statusCode, 200);
  assert.equal(investor.body.eligible, true);

  const rejected = await jsonRequest(app, {
    method: "POST",
    url: "/redemptions/0/reject",
    payload: { reason: "manual review" }
  });
  assert.equal(rejected.statusCode, 200);
});

test("backend handles missing published distributions and request reads", async () => {
  const store = createStateStore();
  store.state.snapshots.push({
    id: 0,
    label: "epoch-2",
    payoutToken: "0x0000000000000000000000000000000000000000",
    snapshotTimestamp: 1717171818,
    metadataURI: "ipfs://snapshot-2",
    root: "0x" + "00".repeat(32),
    allocations: [
      {
        account: "0x3333333333333333333333333333333333333333",
        assetAmount: "10",
        payoutAmount: "1",
        leaf: "0x" + "11".repeat(32),
        proof: []
      }
    ]
  });

  const app = createApp({
    services: {
      chainStatus: () => ({ chainId: 133 }),
      complianceRegistry: null,
      distributionModule: {
        target: "0xdistribution"
      },
      oracleRouter: null,
      redemptionModule: {
        target: "0xredemption",
        async getRequest() {
          return {
            investor: "0x3333333333333333333333333333333333333333",
            assetAmount: 10n,
            payoutAmount: 1n,
            requestedAt: 1n,
            updatedAt: 1n,
            status: 1n,
            memo: "queued"
          };
        }
      },
      servicedAssetToken: null
    },
    stateStore: {
      loadState: store.loadState,
      saveState: store.saveState
    }
  });

  const unpublished = await jsonRequest(app, {
    method: "POST",
    url: "/intents/distributions/0/claim",
    payload: { account: "0x3333333333333333333333333333333333333333" }
  });
  assert.equal(unpublished.statusCode, 404);

  const missingOracle = await jsonRequest(app, {
    method: "GET",
    url: "/oracle/redemption-quote?asset=0x3333333333333333333333333333333333333333&assetAmount=10"
  });
  assert.equal(missingOracle.statusCode, 400);

  const requestRead = await jsonRequest(app, { method: "GET", url: "/redemptions/7" });
  assert.equal(requestRead.statusCode, 200);
  assert.equal(requestRead.body.request.memo, "queued");
});

test("backend uses mined distribution ids instead of pre-read counters", async () => {
  const store = createStateStore();
  store.state.snapshots.push({
    id: 0,
    label: "epoch-race",
    payoutToken: "0x0000000000000000000000000000000000000000",
    snapshotTimestamp: 1717171999,
    metadataURI: "ipfs://snapshot-race",
    root: "0x" + "22".repeat(32),
    allocations: [
      {
        account: "0x1111111111111111111111111111111111111111",
        assetAmount: "10",
        payoutAmount: "1",
        leaf: "0x" + "33".repeat(32),
        proof: []
      }
    ]
  });

  const app = createApp({
    adminApiKey: undefined,
    services: {
      chainStatus: () => ({ chainId: 133 }),
      distributionModule: {
        target: "0xdistribution",
        async createDistribution(...args) {
          return tx("0xdistributiontx-race", {
            hash: "0xdistributiontx-race",
            logs: [
              distributionInterface.encodeEventLog(
                distributionInterface.getEvent("DistributionCreated"),
                [42n, args[0], args[1], BigInt(args[2]), BigInt(args[3]), args[4]]
              )
            ]
          });
        }
      }
    },
    stateStore: {
      loadState: store.loadState,
      saveState: store.saveState
    }
  });

  const published = await jsonRequest(app, {
    method: "POST",
    url: "/admin/distributions/0/publish",
    payload: { nativeValue: "1" }
  });

  assert.equal(published.statusCode, 200);
  assert.equal(store.state.distributions[0].distributionId, 42);
});

test("backend rejects unauthorized admin writes and invalid snapshot payloads", async () => {
  const store = createStateStore();
  const app = createApp({
    adminApiKey: "secret-demo-key",
    services: {
      chainStatus: () => ({ chainId: 133 }),
      complianceRegistry: {
        async setInvestorProfile() {
          return tx("0xprofile");
        }
      }
    },
    stateStore: {
      loadState: store.loadState,
      saveState: store.saveState
    }
  });

  const unauthorized = await jsonRequest(app, {
    method: "POST",
    url: "/admin/investors",
    payload: {
      account: "0x1111111111111111111111111111111111111111",
      approved: true,
      accredited: true,
      frozen: false,
      tier: 3,
      jurisdiction: 344,
      expiry: 1999999999
    }
  });
  assert.equal(unauthorized.statusCode, 401);

  const invalidSnapshot = await jsonRequest(app, {
    method: "POST",
    url: "/admin/snapshots",
    headers: {
      "x-admin-key": "secret-demo-key"
    },
    payload: {
      label: "bad-snapshot",
      payoutToken: "0x0000000000000000000000000000000000000000",
      snapshotTimestamp: 1717171717,
      metadataURI: "ipfs://bad",
      allocations: [
        {
          account: "0x1111111111111111111111111111111111111111",
          assetAmount: "10",
          payoutAmount: "1"
        },
        {
          account: "0x1111111111111111111111111111111111111111",
          assetAmount: "20",
          payoutAmount: "2"
        }
      ]
    }
  });
  assert.equal(invalidSnapshot.statusCode, 400);
  assert.equal(invalidSnapshot.body.error, "validation failed");
});
