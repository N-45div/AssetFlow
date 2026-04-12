import { concat, getBytes, keccak256, AbiCoder } from "ethers";

const abiCoder = AbiCoder.defaultAbiCoder();

export function distributionLeaf({ account, assetAmount, payoutAmount }) {
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

export function buildDistributionTree(allocations) {
  const leaves = allocations.map((allocation) =>
    distributionLeaf({
      account: allocation.account,
      assetAmount: allocation.assetAmount,
      payoutAmount: allocation.payoutAmount
    })
  );

  const layers = buildLayers(leaves);
  const root = layers.at(-1)?.[0] || "0x" + "00".repeat(32);

  return {
    root,
    leaves,
    claims: allocations.map((allocation, index) => ({
      ...allocation,
      leaf: leaves[index],
      proof: buildProof(layers, index)
    }))
  };
}
