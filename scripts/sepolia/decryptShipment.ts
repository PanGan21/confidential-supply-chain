import hre from "hardhat";
import { ethers } from "ethers";
import { FhevmType } from "@fhevm/hardhat-plugin";

import { getArg, loadDotEnv, mustGetEnv, normalizePk, parseArgs } from "./_utils";

async function main() {
  loadDotEnv();
  // NOTE: `hardhat run` does NOT forward custom CLI flags to scripts.
  // Use env vars like SHIPMENT_ID when running via `npx hardhat run`.
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

  const contract = await hre.ethers.getContractAt("ConfidentialSupplyChain", contractAddress, sender);

  const shipment = await contract.getShipment(shipmentId);
  const period = shipment[3] as bigint;
  const sentHandle = shipment[4] as string;
  const lossHandle = shipment[5] as string;
  const receivedHandle = shipment[6] as string;
  const verifiedHandle = shipment[7] as string;
  const sentSet = shipment[8] as boolean;
  const lossSet = shipment[9] as boolean;
  const receivedSet = shipment[10] as boolean;

  console.log(`shipmentId: ${shipmentId.toString()}`);
  console.log(`period: ${period.toString()}`);
  console.log(`sentHandle: ${sentHandle}`);
  console.log(`lossHandle: ${lossHandle}`);
  console.log(`receivedHandle: ${receivedHandle}`);
  console.log(`verifiedHandle: ${verifiedHandle}`);
  console.log(`sentSet: ${String(sentSet)} lossSet: ${String(lossSet)} receivedSet: ${String(receivedSet)}`);

  // Demo test lines 111-117: all 3 participants can decrypt verified
  console.log(`Decrypting verified as sender/transporter/receiver...`);
  const senderSeesVerified = await hre.fhevm.userDecryptEbool(verifiedHandle, contractAddress, sender);
  const transporterSeesVerified = await hre.fhevm.userDecryptEbool(verifiedHandle, contractAddress, transporter);
  const receiverSeesVerified = await hre.fhevm.userDecryptEbool(verifiedHandle, contractAddress, receiver);
  console.log(`sender sees verified: ${String(senderSeesVerified)}`);
  console.log(`transporter sees verified: ${String(transporterSeesVerified)}`);
  console.log(`receiver sees verified: ${String(receiverSeesVerified)}`);

  // Demo test lines 119-126: receiver cannot decrypt sender's sent
  if (sentSet) {
    console.log(`Attempting to decrypt sender's sent as receiver (should fail)...`);
    try {
      const v = await hre.fhevm.userDecryptEuint(FhevmType.euint32, sentHandle, contractAddress, receiver);
      console.log(`Unexpected: receiver decrypted sender sent = ${v.toString()}`);
    } catch (e) {
      console.log(`Expected failure: receiver cannot decrypt sender's sent.`);
      console.log(`Reason: ${(e as Error).message ?? String(e)}`);
    }
  }

  // Demo test lines 128-135: sender can decrypt the sent amount they reported
  if (sentSet) {
    console.log(`Decrypting sender's sent as sender...`);
    const senderSentDecrypted = await hre.fhevm.userDecryptEuint(
      FhevmType.euint32,
      sentHandle,
      contractAddress,
      sender,
    );
    console.log(`sender decrypted sent = ${senderSentDecrypted.toString()}`);
  }

  if (lossSet) {
    console.log(`Decrypting transport loss as transporter...`);
    const loss = await hre.fhevm.userDecryptEuint(FhevmType.euint32, lossHandle, contractAddress, transporter);
    console.log(`transporter decrypted loss = ${loss.toString()}`);
  }

  if (receivedSet) {
    console.log(`Decrypting received as receiver...`);
    const received = await hre.fhevm.userDecryptEuint(FhevmType.euint32, receivedHandle, contractAddress, receiver);
    console.log(`receiver decrypted received = ${received.toString()}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
