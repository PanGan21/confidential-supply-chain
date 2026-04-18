import hre from "hardhat";
import { ethers } from "ethers";
import { FhevmType } from "@fhevm/hardhat-plugin";

import { getArg, loadDotEnv, mustGetEnv, normalizePk, parseArgs } from "./_utils";

type Role = "sender" | "transporter" | "receiver";

function pickRole(v: string | undefined): Role {
  if (v === "sender" || v === "transporter" || v === "receiver") return v;
  return "receiver";
}

async function main() {
  loadDotEnv();
  // NOTE: `hardhat run` does NOT forward custom CLI flags to scripts.
  // Use env vars like COMPANY_ROLE / PERIOD.
  const args = parseArgs(process.argv.slice(2));

  await hre.fhevm.initializeCLIApi();

  const contractAddress = getArg(args, "contract", process.env.CSC_PROXY_ADDRESS);
  if (!contractAddress) throw new Error(`Missing CSC_PROXY_ADDRESS in .env (or pass --contract <address>).`);

  const provider = hre.ethers.provider;

  const sender = new ethers.Wallet(normalizePk(mustGetEnv("SENDER_PRIVATE_KEY")), provider);
  const transporter = new ethers.Wallet(normalizePk(mustGetEnv("TRANSPORTER_PRIVATE_KEY")), provider);
  const receiver = new ethers.Wallet(normalizePk(mustGetEnv("RECEIVER_PRIVATE_KEY")), provider);

  // `COMPANY_ROLE` selects which wallet is *trying to decrypt*.
  // In this flow, the mass-balance report is always *reported by the receiver* (see `reportMassBalance.ts`).
  const companyRole = pickRole((getArg(args, "companyrole") ?? process.env.COMPANY_ROLE)?.toLowerCase());
  const decryptor = companyRole === "sender" ? sender : companyRole === "transporter" ? transporter : receiver;
  const reportingCompany = receiver;

  const contract = await hre.ethers.getContractAt("ConfidentialSupplyChain", contractAddress, decryptor);
  const periodArg = getArg(args, "period") ?? process.env.PERIOD;
  const period = periodArg ? BigInt(periodArg) : ((await contract.currentPeriod()) as bigint);

  const report = await contract.getMassBalanceReport(reportingCompany.address, period);
  const totalInHandle = report[0] as string;
  const totalOutHandle = report[1] as string;
  const processLossHandle = report[2] as string;
  const balancedHandle = report[3] as string;
  const isSet = report[4] as boolean;

  console.log(`decryptorRole: ${companyRole}`);
  console.log(`decryptor: ${decryptor.address}`);
  console.log(`reportingCompanyRole: receiver`);
  console.log(`reportingCompany: ${reportingCompany.address}`);
  console.log(`period: ${period.toString()}`);
  console.log(`isSet: ${String(isSet)}`);
  console.log(`balancedHandle: ${balancedHandle}`);

  if (!isSet) {
    console.log(`No report found. Run reportMassBalance first for receiver+period.`);
    return;
  }

  try {
    const balanced = await hre.fhevm.userDecryptEbool(balancedHandle, contractAddress, decryptor);
    console.log(`decrypted balanced: ${String(balanced)}`);

    const totalIn = await hre.fhevm.userDecryptEuint(FhevmType.euint32, totalInHandle, contractAddress, decryptor);
    const totalOut = await hre.fhevm.userDecryptEuint(FhevmType.euint32, totalOutHandle, contractAddress, decryptor);
    const loss = await hre.fhevm.userDecryptEuint(FhevmType.euint32, processLossHandle, contractAddress, decryptor);

    console.log(`decrypted totalIn: ${totalIn.toString()}`);
    console.log(`decrypted totalOut: ${totalOut.toString()}`);
    console.log(`decrypted processLoss: ${loss.toString()}`);
  } catch (e) {
    console.log(`Decryption failed (expected if decryptor != receiver and no access was granted).`);
    console.log(`Reason: ${(e as Error).message ?? String(e)}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
