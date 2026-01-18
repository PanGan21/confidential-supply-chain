import hre from "hardhat";
import { ethers } from "ethers";

import { getArg, loadDotEnv, mustGetEnv, normalizePk, parseArgs } from "./_utils";

async function main() {
  loadDotEnv();
  // NOTE: `hardhat run` does NOT forward custom CLI flags to scripts.
  // Use env vars like SHIPMENT_ID / SENT when running via `npx hardhat run`.
  const args = parseArgs(process.argv.slice(2));

  await hre.fhevm.initializeCLIApi();

  const contractAddress = getArg(args, "contract", process.env.CSC_PROXY_ADDRESS);
  if (!contractAddress) throw new Error(`Missing CSC_PROXY_ADDRESS in .env (or pass --contract <address>).`);

  const shipmentIdArg = getArg(args, "shipmentid") ?? process.env.SHIPMENT_ID;
  if (!shipmentIdArg) throw new Error(`Missing SHIPMENT_ID in env.`);
  const shipmentId = BigInt(shipmentIdArg);

  const sentArg = getArg(args, "sent") ?? process.env.SENT;
  if (!sentArg) throw new Error(`Missing SENT in env.`);
  const sent = BigInt(sentArg);

  const provider = hre.ethers.provider;
  const sender = new ethers.Wallet(normalizePk(mustGetEnv("SENDER_PRIVATE_KEY")), provider);

  const contract = await hre.ethers.getContractAt("ConfidentialSupplyChain", contractAddress, sender);

  // Helpful pre-checks so repeated runs are obvious.
  try {
    const s = await contract.getShipment(shipmentId);
    const onchainSender = s[0] as string;
    const sentSet = s[8] as boolean;
    console.log(`shipment.sender = ${onchainSender}`);
    console.log(`wallet.sender   = ${sender.address}`);
    console.log(`sentSet         = ${String(sentSet)}`);
    if (sentSet) {
      console.log(`Nothing to do: sent already reported for shipmentId=${shipmentId.toString()}.`);
      return;
    }
  } catch (e) {
    const parsed = await hre.fhevm.tryParseFhevmError(e);
    if (parsed) {
      console.error(parsed.shortMessage);
      console.error(parsed.longMessage);
    }
    throw e;
  }

  const input = hre.fhevm.createEncryptedInput(contractAddress, sender.address);
  input.add32(sent);
  const encSent = await input.encrypt();
  console.log(`encSent.handle[0] = ${hre.ethers.hexlify(encSent.handles[0])}`);
  console.log(`encSent.inputProof = ${hre.ethers.hexlify(encSent.inputProof)}`);

  // Do a preflight to get a clearer error than "execution reverted" during estimateGas.
  try {
    await contract.reportSent.staticCall(shipmentId, encSent.handles[0], encSent.inputProof);
  } catch (e) {
    const parsed = await hre.fhevm.tryParseFhevmError(e, { encryptedInput: input });
    if (parsed) {
      console.error(parsed.shortMessage);
      console.error(parsed.longMessage);
      return;
    }
    throw e;
  }

  try {
    const tx = await contract.reportSent(shipmentId, encSent.handles[0], encSent.inputProof);
    console.log(`tx: ${tx.hash}`);
    await tx.wait();
    console.log(`reportSent confirmed for shipmentId=${shipmentId.toString()}`);
  } catch (e) {
    const parsed = await hre.fhevm.tryParseFhevmError(e, { encryptedInput: input });
    if (parsed) {
      console.error(parsed.shortMessage);
      console.error(parsed.longMessage);
      return;
    }
    throw e;
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
