import { expect } from "chai";
import { network } from "hardhat";

const { ethers } = await network.create();

describe("CAVSRequestRegistry", function () {
  async function deployRegistry() {
    const factory = await ethers.getContractFactory("CAVSRequestRegistry");
    const contract = await factory.deploy();
    await contract.waitForDeployment();
    const [alice] = await ethers.getSigners();
    return { contract, alice };
  }

  async function deployHarness() {
    const factory = await ethers.getContractFactory("CAVSRequestRegistryHarness");
    const contract = await factory.deploy();
    await contract.waitForDeployment();
    const [alice] = await ethers.getSigners();
    return { contract, alice };
  }

  function ids() {
    return {
      requestID: ethers.keccak256(ethers.toUtf8Bytes("request-1")),
      oracleSetID: ethers.keccak256(ethers.toUtf8Bytes("set-1")),
      blobHash: ethers.keccak256(ethers.toUtf8Bytes("blob-1")),
    };
  }

  function keyEnvelopes() {
    return [
      {
        oracleId: 0,
        ephemeralPublicKey: `0x${"11".repeat(32)}`,
        nonce: `0x${"22".repeat(12)}`,
        wrappedARequestKey: `0x${"33".repeat(48)}`,
      },
      {
        oracleId: 1,
        ephemeralPublicKey: `0x${"44".repeat(32)}`,
        nonce: `0x${"55".repeat(12)}`,
        wrappedARequestKey: `0x${"66".repeat(48)}`,
      },
    ];
  }

  it("emits wrapped ARequestKey envelopes via the blob submission path", async function () {
    const { contract, alice } = await deployHarness();
    const { requestID, oracleSetID, blobHash } = ids();
    const nonce = 7n;
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const envelopes = keyEnvelopes();

    await expect(
      contract.submitTestBlobRequest(requestID, oracleSetID, nonce, deadline, blobHash, envelopes)
    )
      .to.emit(contract, "CAVSRequestSubmitted")
      .withArgs(requestID, oracleSetID, alice.address, nonce, deadline, blobHash, [
        [
          envelopes[0].oracleId,
          envelopes[0].ephemeralPublicKey,
          envelopes[0].nonce,
          envelopes[0].wrappedARequestKey,
        ],
        [
          envelopes[1].oracleId,
          envelopes[1].ephemeralPublicKey,
          envelopes[1].nonce,
          envelopes[1].wrappedARequestKey,
        ],
      ]);
  });

  it("rejects duplicate requestID", async function () {
    const { contract } = await deployHarness();
    const { requestID, oracleSetID, blobHash } = ids();
    const envelopes = keyEnvelopes();

    await contract.submitTestBlobRequest(requestID, oracleSetID, 1n, 0n, blobHash, envelopes);
    await expect(contract.submitTestBlobRequest(requestID, oracleSetID, 2n, 0n, blobHash, envelopes))
      .to.be.revertedWithCustomError(contract, "DuplicateRequestID");
  });

  it("rejects missing key envelopes", async function () {
    const { contract } = await deployHarness();
    const { requestID, oracleSetID, blobHash } = ids();

    await expect(contract.submitTestBlobRequest(requestID, oracleSetID, 1n, 0n, blobHash, []))
      .to.be.revertedWithCustomError(contract, "MissingKeyEnvelopes");
  });

  it("rejects blob mode without a blob", async function () {
    const { contract } = await deployRegistry();
    const { requestID, oracleSetID } = ids();

    await expect(contract.submitBlobRequest(requestID, oracleSetID, 1n, 0n, keyEnvelopes()))
      .to.be.revertedWithCustomError(contract, "MissingBlobHash");
  });
});
