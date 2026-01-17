import { DeployFunction } from "hardhat-deploy/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployer } = await hre.getNamedAccounts();
  const { deployments, ethers, upgrades } = hre;

  const PERIOD_DURATION_SECONDS = 3600; // 1-hour reporting periods

  const factory = await ethers.getContractFactory("ConfidentialSupplyChain");
  const proxy = await upgrades.deployProxy(factory, [PERIOD_DURATION_SECONDS], {
    kind: "uups",
    initializer: "initialize",
    // Ensures a fresh implementation address, making verification + proxy linking deterministic
    redeployImplementation: "always",
  });
  await proxy.waitForDeployment();

  const proxyAddress = await proxy.getAddress();
  const implementationAddress = await upgrades.erc1967.getImplementationAddress(proxyAddress);

  const artifact = await deployments.getExtendedArtifact("ConfidentialSupplyChain");
  await deployments.save("ConfidentialSupplyChainProxy", {
    ...artifact,
    address: proxyAddress,
  });
  await deployments.save("ConfidentialSupplyChainImplementation", {
    ...artifact,
    address: implementationAddress,
  });

  console.log(`Deployer: `, deployer);
  console.log(`ConfidentialSupplyChain proxy: `, proxyAddress);
  console.log(`ConfidentialSupplyChain implementation: `, implementationAddress);
  console.log(`PERIOD_DURATION_SECONDS: `, PERIOD_DURATION_SECONDS);
  console.log(`Verify (recommended): npx hardhat csc:verify --network sepolia --proxy ${proxyAddress}`);
};

export default func;
func.id = "deploy_confidential_supply_chain"; // id required to prevent reexecution
func.tags = ["ConfidentialSupplyChain"];
