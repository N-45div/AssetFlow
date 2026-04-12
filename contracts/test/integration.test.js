import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import hre from "hardhat";
import { AbiCoder, concat, getBytes, keccak256 } from "ethers";

const { ethers } = hre;

const buildDir = resolve(process.cwd(), "build");
const abiCoder = AbiCoder.defaultAbiCoder();

function loadArtifact(contractName) {
  const abiPath = resolve(buildDir, `contracts_${contractName}_sol_${contractName}.abi`);
  const binPath = resolve(buildDir, `contracts_${contractName}_sol_${contractName}.bin`);

  return {
    abi: JSON.parse(readFileSync(abiPath, "utf8")),
    bytecode: `0x${readFileSync(binPath, "utf8").trim()}`
  };
}

async function deploy(contractName, signer, args = []) {
  const artifact = loadArtifact(contractName);
  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, signer);
  const contract = await factory.deploy(...args);
  await contract.waitForDeployment();
  return contract;
}

function distributionLeaf({ account, assetAmount, payoutAmount }) {
  return keccak256(
    abiCoder.encode(["address", "uint256", "uint256"], [account, assetAmount, payoutAmount])
  );
}

function hashPair(left, right) {
  if (!right) {
    return left;
  }

  const [sortedLeft, sortedRight] =
    BigInt(left) <= BigInt(right) ? [left, right] : [right, left];

  return keccak256(concat([getBytes(sortedLeft), getBytes(sortedRight)]));
}

function buildLayers(leaves) {
  const layers = [leaves];
  let current = leaves;

  while (current.length > 1) {
    const next = [];

    for (let index = 0; index < current.length; index += 2) {
      next.push(hashPair(current[index], current[index + 1]));
    }

    layers.push(next);
    current = next;
  }

  return layers;
}

function buildProof(layers, index) {
  const proof = [];
  let currentIndex = index;

  for (let layerIndex = 0; layerIndex < layers.length - 1; layerIndex += 1) {
    const layer = layers[layerIndex];
    const siblingIndex = currentIndex ^ 1;

    if (siblingIndex < layer.length) {
      proof.push(layer[siblingIndex]);
    }

    currentIndex = Math.floor(currentIndex / 2);
  }

  return proof;
}

function buildDistribution(allocations) {
  const leaves = allocations.map((allocation) => distributionLeaf(allocation));
  const layers = buildLayers(leaves);

  return {
    root: layers.at(-1)?.[0],
    claims: allocations.map((allocation, index) => ({
      ...allocation,
      proof: buildProof(layers, index)
    }))
  };
}

describe("AssetFlow integration", function () {
  async function fixture({ nativeSettlement = false } = {}) {
    const [admin, issuer, investorA, investorB, outsider, treasury] = await ethers.getSigners();

    const compliance = await deploy("ComplianceRegistry", admin, [admin.address]);
    await (await compliance.connect(admin).setAllowedJurisdiction(344, true)).wait();

    const settlementToken = nativeSettlement
      ? null
      : await deploy("MintableSettlementToken", issuer, ["Demo USD", "dUSD", issuer.address]);
    const assetToken = await deploy("ServicedAssetToken", admin, [
      "HashKey Serviced Fund Unit",
      "hsFU",
      admin.address,
      issuer.address,
      await compliance.getAddress()
    ]);
    const distribution = await deploy("DistributionModule", admin, [admin.address, issuer.address]);
    const redemption = await deploy("RedemptionModule", admin, [
      admin.address,
      issuer.address,
      await assetToken.getAddress(),
      nativeSettlement ? ethers.ZeroAddress : await settlementToken.getAddress()
    ]);

    const servicingRole = await assetToken.SERVICING_ROLE();
    await (await assetToken.connect(admin).grantRole(servicingRole, await redemption.getAddress())).wait();
    await (await compliance.connect(admin).setExemptCounterparty(await redemption.getAddress(), true)).wait();

    const expiry = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;

    for (const investor of [investorA, investorB]) {
      await (
        await compliance.connect(admin).setInvestorProfile(
          investor.address,
          true,
          true,
          false,
          3,
          344,
          expiry
        )
      ).wait();
    }

    return {
      admin,
      issuer,
      investorA,
      investorB,
      outsider,
      treasury,
      compliance,
      settlementToken,
      assetToken,
      distribution,
      redemption
    };
  }

  it("enforces compliance-gated issuance and transfers", async function () {
    const { issuer, investorA, investorB, outsider, assetToken } = await fixture();

    await (await assetToken.connect(issuer).mint(investorA.address, 1_000n)).wait();
    await (await assetToken.connect(investorA).transfer(investorB.address, 250n)).wait();

    assert.equal((await assetToken.balanceOf(investorB.address)).toString(), "250");

    await assert.rejects(assetToken.connect(investorA).transfer(outsider.address, 1n));
    assert.equal((await assetToken.balanceOf(outsider.address)).toString(), "0");
  });

  it("runs distribution and redemption servicing end to end", async function () {
    const {
      issuer,
      investorA,
      investorB,
      treasury,
      settlementToken,
      assetToken,
      distribution,
      redemption
    } = await fixture();

    await (await assetToken.connect(issuer).mint(investorA.address, 600n)).wait();
    await (await assetToken.connect(issuer).mint(investorB.address, 400n)).wait();

    const allocationData = buildDistribution([
      { account: investorA.address, assetAmount: 600n, payoutAmount: 60n },
      { account: investorB.address, assetAmount: 400n, payoutAmount: 40n }
    ]);

    await (await settlementToken.connect(issuer).mint(issuer.address, 1_000n)).wait();
    await (await settlementToken.connect(issuer).approve(await distribution.getAddress(), 100n)).wait();
    await (
      await distribution
        .connect(issuer)
        .createDistribution(await settlementToken.getAddress(), allocationData.root, 100n, 1_717_171_717, "ipfs://dist-1")
    ).wait();

    await (
      await distribution
        .connect(investorA)
        .claim(0, 600n, 60n, allocationData.claims.find((c) => c.account === investorA.address).proof)
    ).wait();

    assert.equal((await settlementToken.balanceOf(investorA.address)).toString(), "60");

    await (await distribution.connect(issuer).cancelDistribution(0, treasury.address)).wait();
    assert.equal((await settlementToken.balanceOf(treasury.address)).toString(), "40");

    await (await settlementToken.connect(issuer).mint(await redemption.getAddress(), 500n)).wait();
    await (await assetToken.connect(investorA).approve(await redemption.getAddress(), 100n)).wait();
    await (await redemption.connect(investorA).requestRedemption(100n, 90n, "monthly window")).wait();
    await (await redemption.connect(issuer).approveRequest(0)).wait();
    await (await redemption.connect(issuer).settleRequest(0)).wait();

    const request = await redemption.getRequest(0);
    assert.equal(request.status, 5n);
    assert.equal((await settlementToken.balanceOf(investorA.address)).toString(), "150");
    assert.equal((await assetToken.balanceOf(investorA.address)).toString(), "500");
    assert.equal((await assetToken.balanceOf(await redemption.getAddress())).toString(), "0");
  });

  it("supports native settlement for distributions and redemptions", async function () {
    const {
      issuer,
      investorA,
      investorB,
      treasury,
      assetToken,
      distribution,
      redemption
    } = await fixture({ nativeSettlement: true });

    await (await assetToken.connect(issuer).mint(investorA.address, 700n)).wait();
    await (await assetToken.connect(issuer).mint(investorB.address, 300n)).wait();

    const beforeTreasuryBalance = await ethers.provider.getBalance(treasury.address);

    const allocationData = buildDistribution([
      { account: investorA.address, assetAmount: 700n, payoutAmount: 70n },
      { account: investorB.address, assetAmount: 300n, payoutAmount: 30n }
    ]);

    await (
      await distribution
        .connect(issuer)
        .createDistribution(ethers.ZeroAddress, allocationData.root, 100n, 1_717_171_818, "ipfs://dist-native", {
          value: 100n
        })
    ).wait();

    await (
      await distribution
        .connect(investorA)
        .claim(0, 700n, 70n, allocationData.claims.find((c) => c.account === investorA.address).proof)
    ).wait();

    assert.equal(
      (await ethers.provider.getBalance(await distribution.getAddress())).toString(),
      "30"
    );

    await (await distribution.connect(issuer).cancelDistribution(0, treasury.address)).wait();
    const afterTreasuryBalance = await ethers.provider.getBalance(treasury.address);
    assert.equal(afterTreasuryBalance - beforeTreasuryBalance, 30n);

    await (await issuer.sendTransaction({ to: await redemption.getAddress(), value: 500n })).wait();
    await (await assetToken.connect(investorA).approve(await redemption.getAddress(), 100n)).wait();

    await (await redemption.connect(investorA).requestRedemption(100n, 90n, "native monthly window")).wait();
    const beforeSettleBalance = await ethers.provider.getBalance(investorA.address);
    await (await redemption.connect(issuer).approveRequest(0)).wait();
    await (await redemption.connect(issuer).settleRequest(0)).wait();

    const afterSettleBalance = await ethers.provider.getBalance(investorA.address);
    assert.equal(afterSettleBalance - beforeSettleBalance, 90n);

    const request = await redemption.getRequest(0);
    assert.equal(request.status, 5n);
    assert.equal((await assetToken.balanceOf(investorA.address)).toString(), "600");
  });

  it("returns redemption units even when the investor becomes ineligible", async function () {
    const {
      admin,
      issuer,
      investorA,
      compliance,
      settlementToken,
      assetToken,
      redemption
    } = await fixture();

    await (await assetToken.connect(issuer).mint(investorA.address, 200n)).wait();
    await (await settlementToken.connect(issuer).mint(await redemption.getAddress(), 500n)).wait();
    await (await assetToken.connect(investorA).approve(await redemption.getAddress(), 150n)).wait();
    await (await redemption.connect(investorA).requestRedemption(150n, 120n, "freeze-path")).wait();

    await (
      await compliance
        .connect(admin)
        .setInvestorProfile(investorA.address, true, true, true, 3, 344, Math.floor(Date.now() / 1000) + 3600)
    ).wait();

    await (await redemption.connect(issuer).rejectRequest(0, "manual review")).wait();

    const request = await redemption.getRequest(0);
    assert.equal(request.status, 3n);
    assert.equal((await assetToken.balanceOf(investorA.address)).toString(), "200");
    assert.equal((await assetToken.balanceOf(await redemption.getAddress())).toString(), "0");
  });

  it("quotes oracle-priced redemptions with stale checks and fee haircuts", async function () {
    const [admin] = await ethers.getSigners();

    const priceFeed = await deploy("MockPriceFeed", admin, [
      8,
      10_125_000_000n,
      BigInt(Math.floor(Date.now() / 1000))
    ]);
    const oracleRouter = await deploy("AssetOracleRouter", admin, [admin.address]);

    const asset = "0x9999999999999999999999999999999999999999";
    await (
      await oracleRouter
        .connect(admin)
        .setFeedConfig(asset, await priceFeed.getAddress(), 18, 86_400, true)
    ).wait();

    const quote = await oracleRouter.getRedemptionQuote(asset, ethers.parseEther("10"), 50, 150);
    assert.equal(quote.grossUsdValue18.toString(), ethers.parseEther("1012.5").toString());
    assert.equal(quote.netUsdValue18.toString(), ethers.parseEther("992.25").toString());

    await (await priceFeed.setRoundData(10_125_000_000n, 1n)).wait();
    await assert.rejects(oracleRouter.getRedemptionQuote(asset, ethers.parseEther("1"), 0, 0));
  });
});
