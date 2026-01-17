import { task } from "hardhat/config";
import type { HardhatRuntimeEnvironment } from "hardhat/types";
import type { TaskArguments } from "hardhat/types";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableNetworkError(e: unknown): boolean {
  const msg = ((e as Error)?.message ?? String(e)).toLowerCase();
  return (
    msg.includes("connect timeout") ||
    msg.includes("timeout") ||
    msg.includes("und_err_connect_timeout") ||
    msg.includes("networkrequesterror")
  );
}

async function withRetries<T>(fn: () => Promise<T>, retries = 3, delayMs = 2500): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i <= retries; i++) {
    try {
      // eslint-disable-next-line no-await-in-loop
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i === retries || !isRetryableNetworkError(e)) throw e;
      // eslint-disable-next-line no-await-in-loop
      await sleep(delayMs * (i + 1));
    }
  }
  // unreachable
  throw lastErr;
}

function getEtherscanApiKey(hre: HardhatRuntimeEnvironment): string | undefined {
  const apiKey = hre.config.etherscan.apiKey;
  if (!apiKey) return undefined;
  if (typeof apiKey === "string") return apiKey;
  if (typeof apiKey === "object") {
    const maybe = (apiKey as Record<string, string | undefined>)[hre.network.name];
    if (typeof maybe === "string") return maybe;
  }
  return undefined;
}

/**
 * Deploys `ConfidentialSupplyChain` behind a UUPS proxy.
 *
 * Usage:
 * - npx hardhat csc:deploy --network sepolia --period 3600
 */
task("csc:deploy", "Deploy ConfidentialSupplyChain behind UUPS proxy")
  .addOptionalParam("period", "Period duration (seconds)", "3600")
  .setAction(async function (taskArguments: TaskArguments, hre) {
    const period = BigInt(taskArguments.period);
    if (period <= 0n || period > 2n ** 64n - 1n) {
      throw new Error("period must fit uint64 and be > 0");
    }

    const [deployer] = await hre.ethers.getSigners();
    const factory = await hre.ethers.getContractFactory("ConfidentialSupplyChain");
    const proxy = await hre.upgrades.deployProxy(factory, [Number(period)], {
      kind: "uups",
      initializer: "initialize",
      redeployImplementation: "always",
    });
    await proxy.waitForDeployment();

    const proxyAddress = await proxy.getAddress();
    const implementationAddress = await hre.upgrades.erc1967.getImplementationAddress(proxyAddress);

    console.log(`Deployer: ${deployer.address}`);
    console.log(`Proxy: ${proxyAddress}`);
    console.log(`Implementation: ${implementationAddress}`);
    console.log(`periodDuration: ${period.toString()}`);
  });

/**
 * Upgrades an existing UUPS proxy to the latest `ConfidentialSupplyChain` implementation.
 *
 * Usage:
 * - npx hardhat csc:upgrade --network sepolia --proxy <PROXY_ADDRESS>
 */
task("csc:upgrade", "Upgrade ConfidentialSupplyChain UUPS proxy")
  .addParam("proxy", "Proxy address")
  .addFlag("redeploy", "Force redeploy implementation even if bytecode is unchanged")
  .setAction(async function (taskArguments: TaskArguments, hre) {
    // Ensure we use the latest compiled artifacts
    await hre.run("compile");

    const proxyAddress = taskArguments.proxy as string;
    const forceRedeploy = Boolean(taskArguments.redeploy);

    const [deployer] = await hre.ethers.getSigners();
    const factory = await hre.ethers.getContractFactory("ConfidentialSupplyChain");

    const provider = hre.ethers.provider;
    const startBlock = await provider.getBlockNumber();

    const oldImplementationAddress = await hre.upgrades.erc1967.getImplementationAddress(proxyAddress);

    // Diagnostics: compare local compiled deployed bytecode vs on-chain implementation bytecode
    const artifact = await hre.artifacts.readArtifact("ConfidentialSupplyChain");
    const localCodeHash = hre.ethers.keccak256(artifact.deployedBytecode);
    const chainCode = await provider.getCode(oldImplementationAddress);
    const chainCodeHash = hre.ethers.keccak256(chainCode);

    // Precompute what implementation would be used (and deploy it if needed)
    const preparedImplementationAddress = (await hre.upgrades.prepareUpgrade(proxyAddress, factory, {
      kind: "uups",
      redeployImplementation: forceRedeploy ? "always" : "onchange",
    })) as string;

    // Perform the upgrade (may be a no-op if already at the prepared implementation)
    await hre.upgrades.upgradeProxy(proxyAddress, factory, {
      kind: "uups",
      redeployImplementation: forceRedeploy ? "always" : "onchange",
    });

    // On some networks/providers, the upgrade tx can be mined slightly after the promise resolves.
    // Poll until the implementation slot reflects the prepared implementation (or timeout).
    let implementationAddress = await hre.upgrades.erc1967.getImplementationAddress(proxyAddress);
    for (let i = 0; i < 24; i++) {
      if (implementationAddress.toLowerCase() === preparedImplementationAddress.toLowerCase()) break;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 5000));
      // eslint-disable-next-line no-await-in-loop
      implementationAddress = await hre.upgrades.erc1967.getImplementationAddress(proxyAddress);
    }

    const endBlock = await provider.getBlockNumber();

    console.log(`Deployer: ${deployer.address}`);
    console.log(`Proxy: ${proxyAddress}`);
    console.log(`Old implementation: ${oldImplementationAddress}`);
    console.log(`Prepared implementation: ${preparedImplementationAddress}`);
    console.log(`New implementation: ${implementationAddress}`);
    console.log(`Local deployedBytecode hash: ${localCodeHash}`);
    console.log(`On-chain impl bytecode hash: ${chainCodeHash}`);

    // Show the actual on-chain upgrade event (if any) from this run.
    const upgradedTopic = hre.ethers.id("Upgraded(address)");
    const logs = await provider.getLogs({
      address: proxyAddress,
      fromBlock: startBlock,
      toBlock: endBlock,
      topics: [upgradedTopic],
    });
    if (logs.length > 0) {
      const last = logs[logs.length - 1]!;
      const implTopic = last.topics[1] ?? "0x";
      const implFromEvent = hre.ethers.getAddress(hre.ethers.dataSlice(implTopic, 12));
      console.log(`Upgraded event detected. tx=${last.transactionHash} implementation=${implFromEvent}`);
    } else {
      console.log(`No Upgraded event detected in blocks [${startBlock}, ${endBlock}].`);
    }

    if (oldImplementationAddress.toLowerCase() === implementationAddress.toLowerCase()) {
      if (localCodeHash === chainCodeHash) {
        console.log(
          `No implementation change detected because the compiled runtime bytecode is identical to what's already deployed.`,
        );
      } else {
        console.log(
          `Local bytecode differs from on-chain implementation, but the proxy did not switch implementations in this run.`,
        );
        console.log(
          `This can happen if an upgrade tx wasn't mined yet, the proxy isn't owned by your signer, or the prepared implementation address matched the current one.`,
        );
      }

      if (!forceRedeploy) {
        console.log(
          `To force a new implementation address anyway, rerun with: npx hardhat csc:upgrade --network <net> --proxy ${proxyAddress} --redeploy`,
        );
      }
    }
  });

/**
 * Prints the current implementation behind a proxy.
 *
 * Usage:
 * - npx hardhat csc:impl --network sepolia --proxy <PROXY_ADDRESS>
 */
task("csc:impl", "Print proxy implementation address")
  .addParam("proxy", "Proxy address")
  .setAction(async function (taskArguments: TaskArguments, hre) {
    const proxyAddress = taskArguments.proxy as string;
    const implementationAddress = await hre.upgrades.erc1967.getImplementationAddress(proxyAddress);
    console.log(`Proxy: ${proxyAddress}`);
    console.log(`Implementation: ${implementationAddress}`);
  });

/**
 * Verifies the implementation (no constructor args) and then links/verifies the proxy.
 *
 * IMPORTANT: Upgradeable contracts use an initializer, not a constructor, so you must NOT pass
 * initializer arguments (e.g. 3600) to `hardhat verify` for the implementation.
 *
 * Usage:
 * - npx hardhat csc:verify --network sepolia --proxy <PROXY_ADDRESS>
 */
task("csc:verify", "Verify ConfidentialSupplyChain proxy + implementation on Etherscan")
  .addParam("proxy", "Proxy address")
  .setAction(async function (taskArguments: TaskArguments, hre) {
    const proxyAddress = taskArguments.proxy as string;
    const implementationAddress = await hre.upgrades.erc1967.getImplementationAddress(proxyAddress);

    console.log(`Proxy: ${proxyAddress}`);
    console.log(`Implementation: ${implementationAddress}`);

    // Then link the proxy to the implementation on Etherscan without re-verifying the proxy source.
    // This avoids the noisy "ERC1967Proxy Already Verified" error.
    const etherscanApiKey = getEtherscanApiKey(hre);
    if (!etherscanApiKey) {
      console.warn(`ETHERSCAN_API_KEY is not set; skipping proxy linking step.`);
      return;
    }

    const network = await hre.ethers.provider.getNetwork();
    const chainid = network.chainId.toString();

    // Verify the implementation first (no constructor args).
    try {
      await withRetries(
        () =>
          hre.run("verify:verify", {
            address: implementationAddress,
            constructorArguments: [],
            force: true,
          }),
        3,
        3000,
      );
    } catch (e) {
      const msg = ((e as Error).message ?? String(e)).toLowerCase();
      if (msg.includes("already been verified") || msg.includes("already verified")) {
        console.log(`Implementation already verified on Etherscan; continuing.`);
      } else {
        throw e;
      }
    }

    // Etherscan v2 requires a supported chainid param. If you're not on a supported chain, skip linking.
    // (Sepolia is 11155111.)
    const supportedChainIds = new Set(["1", "11155111"]);
    if (!supportedChainIds.has(chainid)) {
      console.warn(`ChainId ${chainid} not supported by Etherscan v2 API; skipping proxy linking step.`);
      return;
    }

    try {
      // Etherscan v2 proxy linking (verifyproxycontract + checkproxyverification).
      // Provide chainid in BOTH query string + body for maximum compatibility.
      const submitParams = new URLSearchParams({
        apikey: etherscanApiKey,
        chainid,
        module: "contract",
        action: "verifyproxycontract",
        address: proxyAddress,
        expectedimplementation: implementationAddress,
      });

      const submitUrl = `https://api.etherscan.io/v2/api?${new URLSearchParams({
        apikey: etherscanApiKey,
        chainid,
      }).toString()}`;

      const submit = await withRetries(
        () =>
          fetch(submitUrl, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: submitParams,
          }),
        3,
        3000,
      );

      const submitJson = (await submit.json()) as { status: string; message: string; result: string };
      if (submitJson.status !== "1") {
        throw new Error(`verifyproxycontract failed: ${submitJson.message} ${submitJson.result}`);
      }

      const guid = submitJson.result;
      console.log(`Submitted proxy link request (GUID): ${guid}`);

      for (let i = 0; i < 12; i++) {
        // poll for up to ~60s
        // eslint-disable-next-line no-await-in-loop
        await sleep(5000);

        const checkUrl = `https://api.etherscan.io/v2/api?${new URLSearchParams({
          apikey: etherscanApiKey,
          chainid,
          module: "contract",
          action: "checkproxyverification",
          guid,
        }).toString()}`;

        const check = await withRetries(() => fetch(checkUrl, { method: "GET" }), 3, 3000);
        const checkJson = (await check.json()) as { status: string; message: string; result: string };
        if (checkJson.status === "1") {
          console.log(`Proxy successfully linked to implementation.`);
          return;
        }
        if (checkJson.result?.toLowerCase().includes("does not seem to be verified")) {
          throw new Error(checkJson.result);
        }
        if (checkJson.result?.toLowerCase().includes("already verified")) {
          console.log(`Proxy already linked/verified.`);
          return;
        }
        console.log(`Proxy link status: ${checkJson.result}`);
      }

      console.warn(`Timed out waiting for proxy link status. Check on Etherscan UI for the proxy address.`);
      return;
    } catch (e) {
      // Fallback: ask hardhat-verify to verify/link the proxy.
      // This may throw "Already Verified" but can still link successfully; treat that as non-fatal.
      const msg = (e as Error)?.message ?? String(e);
      console.warn(`Etherscan v2 proxy link failed, falling back to hardhat verify: ${msg}`);

      try {
        await hre.run("verify:verify", {
          address: proxyAddress,
          constructorArguments: [],
          force: true,
        });
      } catch (proxyErr) {
        const proxyMsg = (proxyErr as Error)?.message ?? String(proxyErr);
        if (proxyMsg.toLowerCase().includes("already verified")) {
          console.log(`Proxy already verified; linking may still have been applied.`);
          return;
        }
        console.warn(`Proxy verify/link failed: ${proxyMsg}`);
      }
    }
  });
