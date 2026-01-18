import hre from "hardhat";
import { ethers } from "ethers";

import { getArg, loadDotEnv, mustGetEnv, normalizePk, parseArgs } from "./_utils";

async function main() {
  loadDotEnv();
  // NOTE: `hardhat run` does NOT forward custom CLI flags to scripts.
  // Use env vars like SHIPMENT_ID / RECEIVED when running via `npx hardhat run`.
  const args = parseArgs(process.argv.slice(2));

  await hre.fhevm.initializeCLIApi();

  const contractAddress = getArg(args, "contract", process.env.CSC_PROXY_ADDRESS);
  if (!contractAddress) throw new Error(`Missing CSC_PROXY_ADDRESS in .env (or pass --contract <address>).`);

  const shipmentIdArg = getArg(args, "shipmentid") ?? process.env.SHIPMENT_ID;
  if (!shipmentIdArg) throw new Error(`Missing SHIPMENT_ID in env.`);
  const shipmentId = BigInt(shipmentIdArg);

  const receivedArg = getArg(args, "received") ?? process.env.RECEIVED;
  if (!receivedArg) throw new Error(`Missing RECEIVED in env.`);
  const received = BigInt(receivedArg);

  const provider = hre.ethers.provider;
  const receiver = new ethers.Wallet(normalizePk(mustGetEnv("RECEIVER_PRIVATE_KEY")), provider);

  const contract = await hre.ethers.getContractAt("ConfidentialSupplyChain", contractAddress, receiver);

  const encReceived = await hre.fhevm.createEncryptedInput(contractAddress, receiver.address).add32(received).encrypt();
  console.log(`encReceived.handle[0] = ${hre.ethers.hexlify(encReceived.handles[0])}`);
  console.log(`encReceived.inputProof = ${hre.ethers.hexlify(encReceived.inputProof)}`);

  const tx = await contract.reportReceived(shipmentId, encReceived.handles[0], encReceived.inputProof);
  console.log(`tx: ${tx.hash}`);
  await tx.wait();
  console.log(`reportReceived confirmed for shipmentId=${shipmentId.toString()}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
