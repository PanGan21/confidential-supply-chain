import hre from "hardhat";
import { ethers } from "ethers";

import { getArg, loadDotEnv, mustGetEnv, normalizePk, parseArgs } from "./_utils";

type Role = "sender" | "transporter" | "receiver";

function pickRole(v: string | undefined): Role {
  if (v === "sender" || v === "transporter" || v === "receiver") return v;
  return "receiver";
}

async function main() {
  loadDotEnv();
  // NOTE: `hardhat run` does NOT forward custom CLI flags to scripts.
  // Use env vars like REPORTING_COMPANY_ROLE / PERIOD / AUDITOR_PRIVATE_KEY.
  const args = parseArgs(process.argv.slice(2));

  const contractAddress = getArg(args, "contract", process.env.CSC_PROXY_ADDRESS);
  if (!contractAddress) throw new Error(`Missing CSC_PROXY_ADDRESS in .env (or pass --contract <address>).`);

  const provider = hre.ethers.provider;

  const sender = new ethers.Wallet(normalizePk(mustGetEnv("SENDER_PRIVATE_KEY")), provider);
  const transporter = new ethers.Wallet(normalizePk(mustGetEnv("TRANSPORTER_PRIVATE_KEY")), provider);
  const receiver = new ethers.Wallet(normalizePk(mustGetEnv("RECEIVER_PRIVATE_KEY")), provider);

  const companyRole = pickRole(
    (getArg(args, "reportingcompanyrole") ?? process.env.REPORTING_COMPANY_ROLE)?.toLowerCase(),
  );
  const company = companyRole === "sender" ? sender : companyRole === "transporter" ? transporter : receiver;

  const auditor = new ethers.Wallet(normalizePk(mustGetEnv("AUDITOR_PRIVATE_KEY")), provider);

  const contract = await hre.ethers.getContractAt("ConfidentialSupplyChain", contractAddress, company);
  const periodArg = getArg(args, "period") ?? process.env.PERIOD;
  const period = periodArg ? BigInt(periodArg) : ((await contract.currentPeriod()) as bigint);

  console.log(`companyRole: ${companyRole}`);
  console.log(`company: ${company.address}`);
  console.log(`auditor: ${auditor.address}`);
  console.log(`period: ${period.toString()}`);

  const tx = await contract.allowAuditorForReport(period, auditor.address);
  console.log(`tx: ${tx.hash}`);
  await tx.wait();
  console.log(`allowAuditorForReport confirmed.`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
