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
  // Use env vars like REPORTING_COMPANY_ROLE / COMPANY_ADDRESS / PERIOD / AUDITOR_PRIVATE_KEY.
  const args = parseArgs(process.argv.slice(2));

  await hre.fhevm.initializeCLIApi();

  const contractAddress = getArg(args, "contract", process.env.CSC_PROXY_ADDRESS);
  if (!contractAddress) throw new Error(`Missing CSC_PROXY_ADDRESS in .env (or pass --contract <address>).`);

  const provider = hre.ethers.provider;

  const auditor = new ethers.Wallet(normalizePk(mustGetEnv("AUDITOR_PRIVATE_KEY")), provider);

  const companyAddressOverride = getArg(args, "companyaddress") ?? process.env.COMPANY_ADDRESS;

  let companyAddress: string;
  if (companyAddressOverride) {
    companyAddress = ethers.getAddress(companyAddressOverride);
  } else {
    const senderPk = process.env.SENDER_PRIVATE_KEY;
    const transporterPk = process.env.TRANSPORTER_PRIVATE_KEY;
    const receiverPk = process.env.RECEIVER_PRIVATE_KEY;
    if (!senderPk || !transporterPk || !receiverPk) {
      throw new Error(`Set COMPANY_ADDRESS (or provide SENDER/TRANSPORTER/RECEIVER_PRIVATE_KEY to derive address).`);
    }
    const sender = new ethers.Wallet(normalizePk(senderPk), provider);
    const transporter = new ethers.Wallet(normalizePk(transporterPk), provider);
    const receiver = new ethers.Wallet(normalizePk(receiverPk), provider);

    const companyRole = pickRole(
      (getArg(args, "reportingcompanyrole") ?? process.env.REPORTING_COMPANY_ROLE)?.toLowerCase(),
    );
    companyAddress =
      companyRole === "sender"
        ? sender.address
        : companyRole === "transporter"
          ? transporter.address
          : receiver.address;
  }

  const contract = await hre.ethers.getContractAt("ConfidentialSupplyChain", contractAddress, auditor);
  const periodArg = getArg(args, "period") ?? process.env.PERIOD;
  const period = periodArg ? BigInt(periodArg) : ((await contract.currentPeriod()) as bigint);

  const report = await contract.getMassBalanceReport(companyAddress, period);
  const totalInHandle = report[0] as string;
  const totalOutHandle = report[1] as string;
  const processLossHandle = report[2] as string;
  const balancedHandle = report[3] as string;
  const isSet = report[4] as boolean;

  console.log(`auditor: ${auditor.address}`);
  console.log(`company: ${companyAddress}`);
  console.log(`period: ${period.toString()}`);
  console.log(`isSet: ${String(isSet)}`);

  if (!isSet) {
    console.log(`No report found for company+period.`);
    return;
  }

  const auditorSeesBalanced = await hre.fhevm.userDecryptEbool(balancedHandle, contractAddress, auditor);
  const auditorTotalIn = await hre.fhevm.userDecryptEuint(FhevmType.euint32, totalInHandle, contractAddress, auditor);
  const auditorTotalOut = await hre.fhevm.userDecryptEuint(FhevmType.euint32, totalOutHandle, contractAddress, auditor);
  const auditorLoss = await hre.fhevm.userDecryptEuint(FhevmType.euint32, processLossHandle, contractAddress, auditor);

  console.log(`auditor sees balanced: ${String(auditorSeesBalanced)}`);
  console.log(`auditor decrypted totalIn: ${auditorTotalIn.toString()}`);
  console.log(`auditor decrypted totalOut: ${auditorTotalOut.toString()}`);
  console.log(`auditor decrypted processLoss: ${auditorLoss.toString()}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
