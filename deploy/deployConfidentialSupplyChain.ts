import { DeployFunction } from "hardhat-deploy/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployer } = await hre.getNamedAccounts();
  const { deploy } = hre.deployments;

  const PERIOD_DURATION_SECONDS = 3600; // 1-hour reporting periods

  const deployed = await deploy("ConfidentialSupplyChain", {
    from: deployer,
    args: [PERIOD_DURATION_SECONDS],
    log: true,
  });

  console.log(`ConfidentialSupplyChain contract: `, deployed.address);
  console.log(`PERIOD_DURATION_SECONDS: `, PERIOD_DURATION_SECONDS);
};

export default func;
func.id = "deploy_confidential_supply_chain"; // id required to prevent reexecution
func.tags = ["ConfidentialSupplyChain"];
