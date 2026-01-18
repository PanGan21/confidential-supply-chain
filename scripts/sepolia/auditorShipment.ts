import hre from "hardhat";
import { ethers } from "ethers";
import { FhevmType } from "@fhevm/hardhat-plugin";

import { getArg, loadDotEnv, mustGetEnv, normalizePk, parseArgs } from "./_utils";

type Role = "sender" | "transporter" | "receiver";

function pickRole(v: string | undefined): Role {
  if (v === "sender" || v === "transporter" || v === "receiver") return v;
  return "sender";
}

async function main() {
  loadDotEnv();
  // NOTE: `hardhat run` does NOT forward custom CLI flags to scripts.
  // Use env vars like SHIPMENT_ID / COMPANY_ROLE / AUDITOR_PRIVATE_KEY.
  const args = parseArgs(process.argv.slice(2));

  await hre.fhevm.initializeCLIApi();

  const contractAddress = getArg(args, "contract", process.env.CSC_PROXY_ADDRESS);
  if (!contractAddress) throw new Error(`Missing CSC_PROXY_ADDRESS in .env (or pass --contract <address>).`);

  const shipmentIdArg = getArg(args, "shipmentid") ?? process.env.SHIPMENT_ID;
  if (!shipmentIdArg) throw new Error(`Missing SHIPMENT_ID in env.`);
  const shipmentId = BigInt(shipmentIdArg);

  const provider = hre.ethers.provider;
  const sender = new ethers.Wallet(normalizePk(mustGetEnv("SENDER_PRIVATE_KEY")), provider);
  const transporter = new ethers.Wallet(normalizePk(mustGetEnv("TRANSPORTER_PRIVATE_KEY")), provider);
  const receiver = new ethers.Wallet(normalizePk(mustGetEnv("RECEIVER_PRIVATE_KEY")), provider);
  const auditor = new ethers.Wallet(normalizePk(mustGetEnv("AUDITOR_PRIVATE_KEY")), provider);

  const role = pickRole((getArg(args, "companyrole") ?? process.env.COMPANY_ROLE)?.toLowerCase());
  const grantor = role === "sender" ? sender : role === "transporter" ? transporter : receiver;

  const contractAsGrantor = await hre.ethers.getContractAt("ConfidentialSupplyChain", contractAddress, grantor);
  const contractAsAuditor = await hre.ethers.getContractAt("ConfidentialSupplyChain", contractAddress, auditor);

  console.log(`shipmentId: ${shipmentId.toString()}`);
  console.log(`grantorRole: ${role}`);
  console.log(`grantor: ${grantor.address}`);
  console.log(`auditor: ${auditor.address}`);

  console.log(`Granting auditor access for shipment...`);
  const grantTx = await contractAsGrantor.allowAuditorForShipment(shipmentId, auditor.address);
  console.log(`tx: ${grantTx.hash}`);
  await grantTx.wait();

  const shipment = await contractAsAuditor.getShipment(shipmentId);
  const sentHandle = shipment[4] as string;
  const lossHandle = shipment[5] as string;
  const receivedHandle = shipment[6] as string;
  const verifiedHandle = shipment[7] as string;
  const sentSet = shipment[8] as boolean;
  const lossSet = shipment[9] as boolean;
  const receivedSet = shipment[10] as boolean;

  console.log(`sentSet: ${String(sentSet)} lossSet: ${String(lossSet)} receivedSet: ${String(receivedSet)}`);

  if (sentSet) {
    const v = await hre.fhevm.userDecryptEuint(FhevmType.euint32, sentHandle, contractAddress, auditor);
    console.log(`auditor decrypted sent: ${v.toString()}`);
  }
  if (lossSet) {
    const v = await hre.fhevm.userDecryptEuint(FhevmType.euint32, lossHandle, contractAddress, auditor);
    console.log(`auditor decrypted transportLoss: ${v.toString()}`);
  }
  if (receivedSet) {
    const v = await hre.fhevm.userDecryptEuint(FhevmType.euint32, receivedHandle, contractAddress, auditor);
    console.log(`auditor decrypted received: ${v.toString()}`);
  }
  try {
    const v = await hre.fhevm.userDecryptEbool(verifiedHandle, contractAddress, auditor);
    console.log(`auditor decrypted verified: ${String(v)}`);
  } catch (e) {
    console.log(`verified not decryptable yet (likely not computed): ${(e as Error).message ?? String(e)}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
