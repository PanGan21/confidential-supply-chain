import hre from "hardhat";
import { ethers } from "ethers";

import { getArg, loadDotEnv, mustGetEnv, normalizePk, parseArgs } from "./_utils";

async function main() {
  loadDotEnv();
  // NOTE: `hardhat run` does NOT forward custom CLI flags to scripts.
  // Use env vars like SHIPMENT_ID / LOSS when running via `npx hardhat run`.
  const args = parseArgs(process.argv.slice(2));

  await hre.fhevm.initializeCLIApi();

  const contractAddress = getArg(args, "contract", process.env.CSC_PROXY_ADDRESS);
  if (!contractAddress) throw new Error(`Missing CSC_PROXY_ADDRESS in .env (or pass --contract <address>).`);

  const shipmentIdArg = getArg(args, "shipmentid") ?? process.env.SHIPMENT_ID;
  if (!shipmentIdArg) throw new Error(`Missing SHIPMENT_ID in env.`);
  const shipmentId = BigInt(shipmentIdArg);

  const lossArg = getArg(args, "loss") ?? process.env.LOSS;
  if (!lossArg) throw new Error(`Missing LOSS in env.`);
  const loss = BigInt(lossArg);

  const provider = hre.ethers.provider;
  const transporter = new ethers.Wallet(normalizePk(mustGetEnv("TRANSPORTER_PRIVATE_KEY")), provider);

  const contract = await hre.ethers.getContractAt("ConfidentialSupplyChain", contractAddress, transporter);

  const encLoss = await hre.fhevm.createEncryptedInput(contractAddress, transporter.address).add32(loss).encrypt();
  console.log(`encLoss.handle[0] = ${hre.ethers.hexlify(encLoss.handles[0])}`);
  console.log(`encLoss.inputProof = ${hre.ethers.hexlify(encLoss.inputProof)}`);

  const tx = await contract.reportTransportLoss(shipmentId, encLoss.handles[0], encLoss.inputProof);
  console.log(`tx: ${tx.hash}`);
  await tx.wait();
  console.log(`reportTransportLoss confirmed for shipmentId=${shipmentId.toString()}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
