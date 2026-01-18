import hre from "hardhat";
import { ethers } from "ethers";

import { getArg, loadDotEnv, mustGetEnv, normalizePk, parseArgs } from "./_utils";

async function main() {
  loadDotEnv();
  // NOTE: `hardhat run` does NOT forward custom CLI flags to scripts.
  // Use env vars like PERIOD / TOTAL_IN / TOTAL_OUT / PROCESS_LOSS.
  const args = parseArgs(process.argv.slice(2));

  await hre.fhevm.initializeCLIApi();

  const contractAddress = getArg(args, "contract", process.env.CSC_PROXY_ADDRESS);
  if (!contractAddress) throw new Error(`Missing CSC_PROXY_ADDRESS in .env (or pass --contract <address>).`);

  const provider = hre.ethers.provider;

  // Mass-balance reporting is done by the receiver in this demo flow.
  const receiver = new ethers.Wallet(normalizePk(mustGetEnv("RECEIVER_PRIVATE_KEY")), provider);

  const receiverContract = await hre.ethers.getContractAt("ConfidentialSupplyChain", contractAddress, receiver);

  const totalInArg = getArg(args, "totalin") ?? process.env.TOTAL_IN;
  const totalOutArg = getArg(args, "totalout") ?? process.env.TOTAL_OUT;
  const processLossArg = getArg(args, "processloss") ?? process.env.PROCESS_LOSS;
  if (!totalInArg) throw new Error(`Missing TOTAL_IN in env.`);
  if (!totalOutArg) throw new Error(`Missing TOTAL_OUT in env.`);
  if (!processLossArg) throw new Error(`Missing PROCESS_LOSS in env.`);

  const totalIn = BigInt(totalInArg);
  const totalOut = BigInt(totalOutArg);
  const processLoss = BigInt(processLossArg);

  const periodArg = getArg(args, "period") ?? process.env.PERIOD;
  const period = periodArg ? BigInt(periodArg) : ((await receiverContract.currentPeriod()) as bigint);

  console.log(`reporterRole: receiver`);
  console.log(`reporter: ${receiver.address}`);
  console.log(`period: ${period.toString()}`);

  const input = hre.fhevm.createEncryptedInput(contractAddress, receiver.address);
  input.add32(totalIn);
  input.add32(totalOut);
  input.add32(processLoss);
  const enc = await input.encrypt();

  console.log(`enc.totalIn.handle = ${hre.ethers.hexlify(enc.handles[0])}`);
  console.log(`enc.totalOut.handle = ${hre.ethers.hexlify(enc.handles[1])}`);
  console.log(`enc.processLoss.handle = ${hre.ethers.hexlify(enc.handles[2])}`);
  console.log(`enc.inputProof = ${hre.ethers.hexlify(enc.inputProof)}`);

  const tx = await receiverContract.reportMassBalanceForPeriod(
    period,
    enc.handles[0],
    enc.handles[1],
    enc.handles[2],
    enc.inputProof,
  );
  console.log(`tx: ${tx.hash}`);
  await tx.wait();
  console.log(`reportMassBalanceForPeriod confirmed for receiver=${receiver.address} period=${period.toString()}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
