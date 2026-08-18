import { expect } from "chai";
import { network } from "hardhat";

const { ethers } = await network.create();

describe("CAVSOracleCoordinator", function () {
  const configKey = "0x1111111111111111111111111111111111111111111111111111111111111111";
  const otherConfigKey = "0x2222222222222222222222222222222222222222222222222222222222222222";

  async function deployCoordinator(oracleCount = 4n) {
    const factory = await ethers.getContractFactory("CAVSOracleCoordinator");
    const contract = await factory.deploy(oracleCount);
    await contract.waitForDeployment();

    const [deployer, oracle, otherOracle] = await ethers.getSigners();
    return { contract, deployer, oracle, otherOracle };
  }

  it("stores the configured oracle slot count", async function () {
    const { contract } = await deployCoordinator(7n);

    expect(await contract.oracleCount()).to.equal(7n);
    expect(await contract.registeredOracleCount()).to.equal(0n);
  });

  it("rejects an empty oracle network", async function () {
    const factory = await ethers.getContractFactory("CAVSOracleCoordinator");

    await expect(factory.deploy(0n)).to.be.revertedWithCustomError(factory, "InvalidOracleCount");
  });

  it("registers an explicit oracle slot and exposes its data", async function () {
    const { contract, oracle } = await deployCoordinator();
    const did = "did:ethr:sepolia:0x123";

    await expect(contract.connect(oracle).registerOracle(2n, did, configKey))
      .to.emit(contract, "OracleRegistered")
      .withArgs(2n, oracle.address, did, configKey);

    const registered = await contract.getOracle(2n);
    const registeredIds = await contract.getRegisteredOracleIds();

    expect(await contract.registeredOracleCount()).to.equal(1n);
    expect(registered.oracleId).to.equal(2n);
    expect(registered.account).to.equal(oracle.address);
    expect(registered.did).to.equal(did);
    expect(registered.oraclesEncryptionKey).to.equal(configKey);
    expect(registered.active).to.equal(true);
    expect(registered.updatedAt).to.be.greaterThan(0n);
    expect(registeredIds.length).to.equal(1);
    expect(registeredIds[0]).to.equal(2n);
    expect(await contract.isRegisteredOracle(oracle.address)).to.equal(true);
    expect(await contract.getOracleIdForAccount(oracle.address)).to.equal(2n);
  });

  it("updates the same account's assigned slot without allocating a new slot", async function () {
    const { contract, oracle } = await deployCoordinator();

    await contract.connect(oracle).registerOracle(1n, "did:ethr:sepolia:0xabc", configKey);
    await expect(contract.connect(oracle).registerOracle(1n, "did:ethr:sepolia:0xdef", otherConfigKey))
      .to.emit(contract, "OracleRegistered")
      .withArgs(1n, oracle.address, "did:ethr:sepolia:0xdef", otherConfigKey);

    const registered = await contract.getOracle(1n);
    const registeredIds = await contract.getRegisteredOracleIds();

    expect(await contract.registeredOracleCount()).to.equal(1n);
    expect(registeredIds.length).to.equal(1);
    expect(registeredIds[0]).to.equal(1n);
    expect(registered.did).to.equal("did:ethr:sepolia:0xdef");
    expect(registered.oraclesEncryptionKey).to.equal(otherConfigKey);
    expect(await contract.getOracleIdForAccount(oracle.address)).to.equal(1n);
  });

  it("registers multiple oracle slots in the configured network", async function () {
    const { contract, oracle, otherOracle } = await deployCoordinator();

    await expect(contract.connect(oracle).registerOracle(0n, "did:ethr:sepolia:0x123", configKey))
      .to.emit(contract, "OracleRegistered")
      .withArgs(0n, oracle.address, "did:ethr:sepolia:0x123", configKey);
    await expect(contract.connect(otherOracle).registerOracle(3n, "did:ethr:sepolia:0x456", otherConfigKey))
      .to.emit(contract, "OracleRegistered")
      .withArgs(3n, otherOracle.address, "did:ethr:sepolia:0x456", otherConfigKey);

    const first = await contract.getOracle(0n);
    const second = await contract.getOracle(3n);
    const registeredIds = await contract.getRegisteredOracleIds();

    expect(await contract.registeredOracleCount()).to.equal(2n);
    expect(first.account).to.equal(oracle.address);
    expect(second.account).to.equal(otherOracle.address);
    expect(await contract.isRegisteredOracle(oracle.address)).to.equal(true);
    expect(await contract.isRegisteredOracle(otherOracle.address)).to.equal(true);
    expect(await contract.getOracleIdForAccount(oracle.address)).to.equal(0n);
    expect(await contract.getOracleIdForAccount(otherOracle.address)).to.equal(3n);
    expect(registeredIds[0]).to.equal(0n);
    expect(registeredIds[1]).to.equal(3n);
  });

  it("rejects oracle IDs outside the configured network", async function () {
    const { contract, oracle } = await deployCoordinator(2n);

    await expect(contract.connect(oracle).registerOracle(2n, "did:ethr:sepolia:0x123", configKey))
      .to.be.revertedWithCustomError(contract, "OracleIdOutOfRange");
    await expect(contract.getOracle(2n))
      .to.be.revertedWithCustomError(contract, "OracleIdOutOfRange");
  });

  it("rejects missing oracle encryption keys", async function () {
    const { contract, oracle } = await deployCoordinator();

    await expect(contract.connect(oracle).registerOracle(0n, "did:ethr:sepolia:0x123", ethers.ZeroHash))
      .to.be.revertedWithCustomError(contract, "OraclesEncryptionKeyRequired");
  });

  it("prevents one account from claiming multiple oracle slots", async function () {
    const { contract, oracle } = await deployCoordinator();

    await contract.connect(oracle).registerOracle(0n, "did:ethr:sepolia:0x123", configKey);

    await expect(contract.connect(oracle).registerOracle(1n, "did:ethr:sepolia:0x123", configKey))
      .to.be.revertedWithCustomError(contract, "AccountAlreadyRegistered");
  });

  it("prevents another account from replacing an occupied oracle slot", async function () {
    const { contract, oracle, otherOracle } = await deployCoordinator();

    await contract.connect(oracle).registerOracle(0n, "did:ethr:sepolia:0x123", configKey);

    await expect(contract.connect(otherOracle).registerOracle(0n, "did:ethr:sepolia:0x456", otherConfigKey))
      .to.be.revertedWithCustomError(contract, "OracleIdAlreadyRegistered");
  });

  it("gates requireRegisteredOracleAccount to registered accounts only", async function () {
    const { contract, oracle, otherOracle } = await deployCoordinator();

    await expect(contract.connect(otherOracle).requireRegisteredOracleAccount())
      .to.be.revertedWithCustomError(contract, "CallerNotRegisteredOracle");

    await contract.connect(oracle).registerOracle(3n, "did:ethr:sepolia:0x456", configKey);

    expect(await contract.connect(oracle).requireRegisteredOracleAccount()).to.equal(3n);
  });

  it("reverts account id lookup for unregistered accounts", async function () {
    const { contract, otherOracle } = await deployCoordinator();

    await expect(contract.getOracleIdForAccount(otherOracle.address))
      .to.be.revertedWithCustomError(contract, "AccountNotRegistered");
  });
});
