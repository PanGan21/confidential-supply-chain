import hre from "hardhat";
import { ethers } from "ethers";

import { getArg, loadDotEnv, mustGetEnv, normalizePk, parseArgs } from "./_utils";

async function main() {
  loadDotEnv();
  const args = parseArgs(process.argv.slice(2));

  const contractAddress = getArg(args, "contract", process.env.CSC_PROXY_ADDRESS);
  if (!contractAddress) throw new Error(`Missing CSC_PROXY_ADDRESS in .env (or pass --contract <address>).`);

  const provider = hre.ethers.provider;

  const owner = new ethers.Wallet(normalizePk(mustGetEnv("OWNER_PRIVATE_KEY")), provider);
  const sender = new ethers.Wallet(normalizePk(mustGetEnv("SENDER_PRIVATE_KEY")), provider);
  const transporter = new ethers.Wallet(normalizePk(mustGetEnv("TRANSPORTER_PRIVATE_KEY")), provider);
  const receiver = new ethers.Wallet(normalizePk(mustGetEnv("RECEIVER_PRIVATE_KEY")), provider);

  const auditorPk = process.env.AUDITOR_PRIVATE_KEY ? normalizePk(process.env.AUDITOR_PRIVATE_KEY) : undefined;
  const auditorAddress =
    process.env.AUDITOR_ADDRESS ?? (auditorPk ? new ethers.Wallet(auditorPk, provider).address : undefined);

  const contract = await hre.ethers.getContractAt("ConfidentialSupplyChain", contractAddress, owner);

  console.log(`owner: ${owner.address}`);
  console.log(`sender: ${sender.address}`);
  console.log(`transporter: ${transporter.address}`);
  console.log(`receiver: ${receiver.address}`);
  if (auditorAddress) console.log(`auditor: ${auditorAddress}`);

  console.log(`Setting companies...`);
  await (await contract.setCompany(sender.address, true)).wait();
  await (await contract.setCompany(transporter.address, true)).wait();
  await (await contract.setCompany(receiver.address, true)).wait();

  if (auditorAddress) {
    console.log(`Setting auditor...`);
    await (await contract.setAuditor(auditorAddress, true)).wait();
  } else {
    console.log(`AUDITOR_PRIVATE_KEY/AUDITOR_ADDRESS not set; skipping setAuditor.`);
  }

  console.log(`Allowlist setup complete.`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
