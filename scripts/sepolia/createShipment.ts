import hre from "hardhat";
import { ethers } from "ethers";

import { getArg, loadDotEnv, mustGetEnv, normalizePk, parseArgs } from "./_utils";

async function main() {
  loadDotEnv();
  const args = parseArgs(process.argv.slice(2));

  const contractAddress = getArg(args, "contract", process.env.CSC_PROXY_ADDRESS);
  if (!contractAddress) throw new Error(`Missing CSC_PROXY_ADDRESS in .env (or pass --contract <address>).`);

  const provider = hre.ethers.provider;
  const sender = new ethers.Wallet(normalizePk(mustGetEnv("SENDER_PRIVATE_KEY")), provider);
  const transporter = new ethers.Wallet(normalizePk(mustGetEnv("TRANSPORTER_PRIVATE_KEY")), provider);
  const receiver = new ethers.Wallet(normalizePk(mustGetEnv("RECEIVER_PRIVATE_KEY")), provider);

  const contract = await hre.ethers.getContractAt("ConfidentialSupplyChain", contractAddress, sender);

  const nextId = (await contract.nextShipmentId()) as bigint;
  console.log(`sender: ${sender.address}`);
  console.log(`transporter: ${transporter.address}`);
  console.log(`receiver: ${receiver.address}`);
  console.log(`creating shipmentId: ${nextId.toString()}`);

  const tx = await contract.createShipment(transporter.address, receiver.address);
  console.log(`tx: ${tx.hash}`);
  await tx.wait();

  const s = await contract.getShipment(nextId);
  console.log(`shipmentId: ${nextId.toString()}`);
  console.log(`shipment.sender: ${s[0] as string}`);
  console.log(`shipment.transporter: ${s[1] as string}`);
  console.log(`shipment.receiver: ${s[2] as string}`);
  console.log(`shipment.period: ${(s[3] as bigint).toString()}`);
  console.log(`sentSet: ${String(s[8] as boolean)}`);
  console.log(`lossSet: ${String(s[9] as boolean)}`);
  console.log(`receivedSet: ${String(s[10] as boolean)}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
