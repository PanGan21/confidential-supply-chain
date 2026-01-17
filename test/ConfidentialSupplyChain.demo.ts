import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { ethers, fhevm, upgrades } from "hardhat";
import { FhevmType } from "@fhevm/hardhat-plugin";

import { ConfidentialSupplyChain, ConfidentialSupplyChain__factory } from "../types";

type Signers = {
  deployer: HardhatEthersSigner;
  sender: HardhatEthersSigner;
  transporter: HardhatEthersSigner;
  receiver: HardhatEthersSigner;
  auditor: HardhatEthersSigner;
  stranger: HardhatEthersSigner;
};

async function deployFixture() {
  const factory = (await ethers.getContractFactory("ConfidentialSupplyChain")) as ConfidentialSupplyChain__factory;
  const proxy = await upgrades.deployProxy(factory, [3600], { kind: "uups", initializer: "initialize" });
  await proxy.waitForDeployment();
  const contract = proxy as unknown as ConfidentialSupplyChain;
  const contractAddress = await contract.getAddress();
  return { contract, contractAddress };
}

describe("ConfidentialSupplyChain", function () {
  let signers: Signers;
  let contract: ConfidentialSupplyChain;
  let contractAddress: string;

  before(async function () {
    const ethSigners = await ethers.getSigners();
    signers = {
      deployer: ethSigners[0],
      sender: ethSigners[1],
      transporter: ethSigners[2],
      receiver: ethSigners[3],
      auditor: ethSigners[4],
      stranger: ethSigners[5],
    };
  });

  beforeEach(async function () {
    // This suite relies on the local/mock FHEVM environment.
    if (!fhevm.isMock) {
      console.warn(`This hardhat test suite cannot run on Sepolia Testnet`);
      this.skip();
    }
    ({ contract, contractAddress } = await deployFixture());

    // Access control setup (admin allowlists)
    await (await contract.connect(signers.deployer).setCompany(signers.sender.address, true)).wait();
    await (await contract.connect(signers.deployer).setCompany(signers.transporter.address, true)).wait();
    await (await contract.connect(signers.deployer).setCompany(signers.receiver.address, true)).wait();
    await (await contract.connect(signers.deployer).setAuditor(signers.auditor.address, true)).wait();
  });

  it("tracks a shipment and verifies received == sent - transportLoss without revealing values", async function () {
    const period0 = await contract.currentPeriod();

    // Sender creates a shipment to receiver using a transporter.
    const createTx = await contract
      .connect(signers.sender)
      .createShipment(signers.transporter.address, signers.receiver.address);
    await createTx.wait();
    const shipmentId = 0n;

    // Sender reports sent amount (encrypted).
    const sentClear = 100;
    const encSent = await fhevm
      .createEncryptedInput(contractAddress, signers.sender.address)
      .add32(sentClear)
      .encrypt();
    await (
      await contract.connect(signers.sender).reportSent(shipmentId, encSent.handles[0], encSent.inputProof)
    ).wait();

    // Transporter reports transport loss (encrypted).
    const lossClear = 3;
    const encLoss = await fhevm
      .createEncryptedInput(contractAddress, signers.transporter.address)
      .add32(lossClear)
      .encrypt();
    await (
      await contract
        .connect(signers.transporter)
        .reportTransportLoss(shipmentId, encLoss.handles[0], encLoss.inputProof)
    ).wait();

    // Receiver reports received amount (encrypted).
    const receivedClear = 97;
    const encReceived = await fhevm
      .createEncryptedInput(contractAddress, signers.receiver.address)
      .add32(receivedClear)
      .encrypt();
    await (
      await contract
        .connect(signers.receiver)
        .reportReceived(shipmentId, encReceived.handles[0], encReceived.inputProof)
    ).wait();

    const [, , , period, sentHandle, lossHandle, receivedHandle, verifiedHandle] =
      await contract.getShipment(shipmentId);
    expect(period).to.eq(period0);
    expect(sentHandle).to.not.eq(ethers.ZeroHash);
    expect(lossHandle).to.not.eq(ethers.ZeroHash);
    expect(receivedHandle).to.not.eq(ethers.ZeroHash);
    expect(verifiedHandle).to.not.eq(ethers.ZeroHash);

    // All 3 participants can decrypt the *boolean* verification result.
    const senderSeesVerified = await fhevm.userDecryptEbool(verifiedHandle, contractAddress, signers.sender);
    const transporterSeesVerified = await fhevm.userDecryptEbool(verifiedHandle, contractAddress, signers.transporter);
    const receiverSeesVerified = await fhevm.userDecryptEbool(verifiedHandle, contractAddress, signers.receiver);
    expect(senderSeesVerified).to.eq(true);
    expect(transporterSeesVerified).to.eq(true);
    expect(receiverSeesVerified).to.eq(true);

    // But they cannot decrypt each other's private numbers.
    let receiverCouldDecryptSenderSent = true;
    try {
      await fhevm.userDecryptEuint(FhevmType.euint32, sentHandle, contractAddress, signers.receiver);
    } catch {
      receiverCouldDecryptSenderSent = false;
    }
    expect(receiverCouldDecryptSenderSent).to.eq(false);

    // Sender can decrypt the sent amount they reported.
    const senderSentDecrypted = await fhevm.userDecryptEuint(
      FhevmType.euint32,
      sentHandle,
      contractAddress,
      signers.sender,
    );
    expect(senderSentDecrypted).to.eq(BigInt(sentClear));

    // Optional: grant an auditor access and prove the auditor can decrypt.
    await (await contract.connect(signers.sender).allowAuditorForShipment(shipmentId, signers.auditor.address)).wait();
    const auditorSeesSent = await fhevm.userDecryptEuint(
      FhevmType.euint32,
      sentHandle,
      contractAddress,
      signers.auditor,
    );
    expect(auditorSeesSent).to.eq(BigInt(sentClear));
  });

  it("enforces owner-only allowlist management", async function () {
    await expect(contract.connect(signers.sender).setCompany(signers.stranger.address, true))
      .to.be.revertedWithCustomError(contract, "OwnableUnauthorizedAccount")
      .withArgs(signers.sender.address);

    await expect(contract.connect(signers.sender).setAuditor(signers.stranger.address, true))
      .to.be.revertedWithCustomError(contract, "OwnableUnauthorizedAccount")
      .withArgs(signers.sender.address);

    await expect(contract.connect(signers.sender).transferOwnership(signers.sender.address))
      .to.be.revertedWithCustomError(contract, "OwnableUnauthorizedAccount")
      .withArgs(signers.sender.address);
  });

  it("prevents non-companies from creating shipments and reporting", async function () {
    await expect(
      contract.connect(signers.stranger).createShipment(signers.transporter.address, signers.receiver.address),
    ).to.be.revertedWithCustomError(contract, "CompanyNotAllowed");

    // Also blocks mass-balance reporting
    const period = await contract.currentPeriod();
    const enc = await fhevm
      .createEncryptedInput(contractAddress, signers.stranger.address)
      .add32(1)
      .add32(1)
      .add32(0)
      .encrypt();

    await expect(
      contract
        .connect(signers.stranger)
        .reportMassBalanceForPeriod(period, enc.handles[0], enc.handles[1], enc.handles[2], enc.inputProof),
    ).to.be.revertedWithCustomError(contract, "CompanyNotAllowed");
  });

  it("prevents creating shipments with unapproved participants", async function () {
    // Remove receiver from allowlist, then creation should fail
    await (await contract.connect(signers.deployer).setCompany(signers.receiver.address, false)).wait();

    await expect(
      contract.connect(signers.sender).createShipment(signers.transporter.address, signers.receiver.address),
    ).to.be.revertedWithCustomError(contract, "CompanyNotAllowed");
  });

  it("requires auditors to be allowlisted before granting access", async function () {
    // Remove auditor from allowlist
    await (await contract.connect(signers.deployer).setAuditor(signers.auditor.address, false)).wait();

    // Create a shipment
    await (
      await contract.connect(signers.sender).createShipment(signers.transporter.address, signers.receiver.address)
    ).wait();
    const shipmentId = 0n;

    // Granting shipment auditor access should fail
    await expect(
      contract.connect(signers.sender).allowAuditorForShipment(shipmentId, signers.auditor.address),
    ).to.be.revertedWithCustomError(contract, "AuditorNotAllowed");

    // Create a report then try to grant report auditor access should also fail
    const period = await contract.currentPeriod();
    const enc = await fhevm
      .createEncryptedInput(contractAddress, signers.receiver.address)
      .add32(10)
      .add32(9)
      .add32(1)
      .encrypt();
    await (
      await contract
        .connect(signers.receiver)
        .reportMassBalanceForPeriod(period, enc.handles[0], enc.handles[1], enc.handles[2], enc.inputProof)
    ).wait();

    await expect(
      contract.connect(signers.receiver).allowAuditorForReport(period, signers.auditor.address),
    ).to.be.revertedWithCustomError(contract, "AuditorNotAllowed");
  });

  it("supports per-period encrypted mass-balance reporting (totalIn == totalOut + loss)", async function () {
    const period = await contract.currentPeriod();

    // Receiver reports their mass balance for the period:
    // totalIn=97, totalOut=96, processLoss=1 => balanced
    const enc = await fhevm
      .createEncryptedInput(contractAddress, signers.receiver.address)
      .add32(97)
      .add32(96)
      .add32(1)
      .encrypt();

    await (
      await contract
        .connect(signers.receiver)
        .reportMassBalanceForPeriod(period, enc.handles[0], enc.handles[1], enc.handles[2], enc.inputProof)
    ).wait();

    const [totalInHandle, totalOutHandle, processLossHandle, balancedHandle, isSet] =
      await contract.getMassBalanceReport(signers.receiver.address, period);
    expect(isSet).to.eq(true);
    expect(totalInHandle).to.not.eq(ethers.ZeroHash);
    expect(balancedHandle).to.not.eq(ethers.ZeroHash);

    const receiverSeesBalanced = await fhevm.userDecryptEbool(balancedHandle, contractAddress, signers.receiver);
    expect(receiverSeesBalanced).to.eq(true);

    // Another participant cannot decrypt receiver's totals unless permission is granted.
    let senderCouldDecryptReceiverTotals = true;
    try {
      await fhevm.userDecryptEuint(FhevmType.euint32, totalInHandle, contractAddress, signers.sender);
    } catch {
      senderCouldDecryptReceiverTotals = false;
    }
    expect(senderCouldDecryptReceiverTotals).to.eq(false);

    // Receiver can optionally allow an auditor.
    await (await contract.connect(signers.receiver).allowAuditorForReport(period, signers.auditor.address)).wait();
    const auditorSeesTotalIn = await fhevm.userDecryptEuint(
      FhevmType.euint32,
      totalInHandle,
      contractAddress,
      signers.auditor,
    );
    const auditorSeesTotalOut = await fhevm.userDecryptEuint(
      FhevmType.euint32,
      totalOutHandle,
      contractAddress,
      signers.auditor,
    );
    const auditorSeesLoss = await fhevm.userDecryptEuint(
      FhevmType.euint32,
      processLossHandle,
      contractAddress,
      signers.auditor,
    );
    expect(auditorSeesTotalIn).to.eq(97n);
    expect(auditorSeesTotalOut).to.eq(96n);
    expect(auditorSeesLoss).to.eq(1n);
  });

  it("separates reports by configurable time periods", async function () {
    const period0 = await contract.currentPeriod();

    await (
      await contract.connect(signers.sender).createShipment(signers.transporter.address, signers.receiver.address)
    ).wait();

    await time.increase(3600);
    const period1 = await contract.currentPeriod();
    expect(period1).to.eq(period0 + 1n);

    await (
      await contract.connect(signers.sender).createShipment(signers.transporter.address, signers.receiver.address)
    ).wait();

    const [, , , p0] = await contract.getShipment(0n);
    const [, , , p1] = await contract.getShipment(1n);
    expect(p0).to.eq(period0);
    expect(p1).to.eq(period1);
  });
});
