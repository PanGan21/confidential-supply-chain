// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FHE, ebool, euint32, externalEuint32} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

/// @title ConfidentialSupplyChain
/// @author Panagiotis Ganelis - PanGan21
/// @notice Tracks shipments and per-period mass-balance reports with encrypted values (FHEVM).
/// @dev This contract computes encrypted verification flags (ebool).
contract ConfidentialSupplyChain is Initializable, OwnableUpgradeable, UUPSUpgradeable {
    /// @notice Duration (in seconds) of a reporting period.
    uint64 public periodDuration;

    /// @notice Whether an address is an approved supply-chain company (can create/report).
    mapping(address company => bool allowed) public isCompany;

    /// @notice Whether an address is an approved auditor (can be granted decryption access).
    mapping(address auditor => bool allowed) public isAuditor;

    // solhint-disable-next-line gas-struct-packing
    struct Shipment {
        address sender;
        address transporter;
        address receiver;
        uint256 period;
        euint32 sent;
        euint32 transportLoss;
        euint32 received;
        ebool verified; // initialized only once all three numbers are provided
        bool sentSet;
        bool lossSet;
        bool receivedSet;
    }

    struct MassBalanceReport {
        euint32 totalIn;
        euint32 totalOut;
        euint32 processLoss;
        ebool balanced; // totalIn == totalOut + processLoss
        bool isSet;
    }

    /// @notice Auto-incremented shipment id counter used to assign new ids.
    uint256 public nextShipmentId;

    mapping(uint256 shipmentId => Shipment shipment) private _shipments;
    mapping(address company => mapping(uint256 period => MassBalanceReport report)) private _reports;

    /// @notice Emitted when a shipment is created.
    /// @param shipmentId The created shipment id.
    /// @param period The reporting period in which the shipment was created.
    /// @param sender The sender company.
    /// @param transporter The transporter.
    /// @param receiver The receiver company.
    event ShipmentCreated(
        uint256 indexed shipmentId,
        uint256 indexed period,
        address indexed sender,
        address transporter,
        address receiver
    );
    /// @notice Emitted when a shipment participant reports a confidential field.
    /// @param shipmentId The shipment id.
    /// @param reporter The address that submitted the encrypted value.
    event ShipmentFieldReported(uint256 indexed shipmentId, address indexed reporter);
    /// @notice Emitted once a shipment has enough information to compute the verification flag.
    /// @param shipmentId The shipment id.
    event ShipmentVerified(uint256 indexed shipmentId);
    /// @notice Emitted when a company submits a mass-balance report for a period.
    /// @param period The reporting period.
    /// @param company The reporting company.
    event MassBalanceReported(uint256 indexed period, address indexed company);
    /// @notice Emitted when a company allowlist status is updated.
    /// @param company The company address.
    /// @param allowed Whether the company is allowed.
    event CompanyAllowlistUpdated(address indexed company, bool indexed allowed);
    /// @notice Emitted when an auditor allowlist status is updated.
    /// @param auditor The auditor address.
    /// @param allowed Whether the auditor is allowed.
    event AuditorAllowlistUpdated(address indexed auditor, bool indexed allowed);

    error InvalidAddress();
    error NotShipmentParticipant();
    error NotSender();
    error NotTransporter();
    error NotReceiver();
    error ShipmentDoesNotExist();
    error AlreadyReported();
    error InvalidPeriodDuration();
    error CompanyNotAllowed();
    error AuditorNotAllowed();

    /// @notice Disables initializer on the implementation contract.
    /// @dev Prevents someone from calling `initialize` on the implementation directly.
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initializes the proxy.
    /// @param _periodDuration Duration (in seconds) of a reporting period.
    function initialize(uint64 _periodDuration) external initializer {
        if (_periodDuration == 0) revert InvalidPeriodDuration();

        // Initialize OZ upgradeable modules
        __Ownable_init(msg.sender);
        __UUPSUpgradeable_init();

        // Initialize FHEVM coprocessor config in the proxy storage
        FHE.setCoprocessor(ZamaConfig.getEthereumCoprocessorConfig());

        periodDuration = _periodDuration;
    }

    /// @notice Returns the current confidential protocol id for the active chain.
    /// @return protocolId The confidential protocol id.
    function confidentialProtocolId() public view returns (uint256) {
        return ZamaConfig.getConfidentialProtocolId();
    }

    /// @notice Restricts a function to approved companies.
    modifier onlyCompany() {
        if (!isCompany[msg.sender]) revert CompanyNotAllowed();
        _;
    }

    /// @notice Adds/removes a company from the allowlist.
    /// @param company The company address.
    /// @param allowed Whether the company is allowed.
    function setCompany(address company, bool allowed) external onlyOwner {
        if (company == address(0)) revert InvalidAddress();
        isCompany[company] = allowed;
        emit CompanyAllowlistUpdated(company, allowed);
    }

    /// @notice Adds/removes an auditor from the allowlist.
    /// @param auditor The auditor address.
    /// @param allowed Whether the auditor is allowed.
    function setAuditor(address auditor, bool allowed) external onlyOwner {
        if (auditor == address(0)) revert InvalidAddress();
        isAuditor[auditor] = allowed;
        emit AuditorAllowlistUpdated(auditor, allowed);
    }

    /// @notice Returns the current reporting period index.
    /// @return period The current period.
    function currentPeriod() public view returns (uint256) {
        return block.timestamp / periodDuration;
    }

    /// @notice Creates a new shipment in the current period.
    /// @param transporter The transporter that will report transport loss.
    /// @param receiver The receiver that will report received amount.
    /// @return shipmentId The created shipment id.
    function createShipment(address transporter, address receiver) external onlyCompany returns (uint256 shipmentId) {
        if (transporter == address(0) || receiver == address(0)) revert InvalidAddress();
        if (!isCompany[transporter] || !isCompany[receiver]) revert CompanyNotAllowed();

        shipmentId = nextShipmentId;
        unchecked {
            ++nextShipmentId;
        }
        Shipment storage s = _shipments[shipmentId];
        s.sender = msg.sender;
        s.transporter = transporter;
        s.receiver = receiver;
        s.period = currentPeriod();

        emit ShipmentCreated(shipmentId, s.period, s.sender, s.transporter, s.receiver);
    }

    /// @notice Returns all encrypted fields and metadata for a shipment.
    /// @param shipmentId The shipment id.
    /// @return sender The sender company.
    /// @return transporter The transporter.
    /// @return receiver The receiver company.
    /// @return period The reporting period in which the shipment was created.
    /// @return sent The encrypted sent amount (if reported, else uninitialized handle).
    /// @return transportLoss The encrypted transport loss (if reported, else uninitialized handle).
    /// @return received The encrypted received amount (if reported, else uninitialized handle).
    /// @return verified The encrypted verification flag (if computed, else uninitialized handle).
    /// @return sentSet Whether `sent` was reported.
    /// @return lossSet Whether `transportLoss` was reported.
    /// @return receivedSet Whether `received` was reported.
    function getShipment(
        uint256 shipmentId
    )
        external
        view
        returns (
            address sender,
            address transporter,
            address receiver,
            uint256 period,
            euint32 sent,
            euint32 transportLoss,
            euint32 received,
            ebool verified,
            bool sentSet,
            bool lossSet,
            bool receivedSet
        )
    {
        Shipment storage s = _shipments[shipmentId];
        if (s.sender == address(0)) revert ShipmentDoesNotExist();

        return (
            s.sender,
            s.transporter,
            s.receiver,
            s.period,
            s.sent,
            s.transportLoss,
            s.received,
            s.verified,
            s.sentSet,
            s.lossSet,
            s.receivedSet
        );
    }

    /// @notice Reports the encrypted sent amount for a shipment.
    /// @param shipmentId The shipment id.
    /// @param sentExt The encrypted sent amount (external handle).
    /// @param proof The input proof.
    function reportSent(uint256 shipmentId, externalEuint32 sentExt, bytes calldata proof) external {
        Shipment storage s = _shipments[shipmentId];
        if (s.sender == address(0)) revert ShipmentDoesNotExist();
        if (msg.sender != s.sender) revert NotSender();
        if (!isCompany[msg.sender]) revert CompanyNotAllowed();
        if (s.sentSet) revert AlreadyReported();

        s.sent = FHE.fromExternal(sentExt, proof);
        s.sentSet = true;

        // Confidentiality: only sender can decrypt sent amount (besides the contract itself)
        FHE.allowThis(s.sent);
        FHE.allow(s.sent, s.sender);

        emit ShipmentFieldReported(shipmentId, msg.sender);
        _tryVerifyShipment(shipmentId);
    }

    /// @notice Reports the encrypted transportation loss for a shipment.
    /// @param shipmentId The shipment id.
    /// @param lossExt The encrypted transport loss (external handle).
    /// @param proof The input proof.
    function reportTransportLoss(uint256 shipmentId, externalEuint32 lossExt, bytes calldata proof) external {
        Shipment storage s = _shipments[shipmentId];
        if (s.sender == address(0)) revert ShipmentDoesNotExist();
        if (msg.sender != s.transporter) revert NotTransporter();
        if (!isCompany[msg.sender]) revert CompanyNotAllowed();
        if (s.lossSet) revert AlreadyReported();

        s.transportLoss = FHE.fromExternal(lossExt, proof);
        s.lossSet = true;

        // Confidentiality: only transporter can decrypt transport loss (besides the contract itself)
        FHE.allowThis(s.transportLoss);
        FHE.allow(s.transportLoss, s.transporter);

        emit ShipmentFieldReported(shipmentId, msg.sender);
        _tryVerifyShipment(shipmentId);
    }

    /// @notice Reports the encrypted received amount for a shipment.
    /// @param shipmentId The shipment id.
    /// @param receivedExt The encrypted received amount (external handle).
    /// @param proof The input proof.
    function reportReceived(uint256 shipmentId, externalEuint32 receivedExt, bytes calldata proof) external {
        Shipment storage s = _shipments[shipmentId];
        if (s.sender == address(0)) revert ShipmentDoesNotExist();
        if (msg.sender != s.receiver) revert NotReceiver();
        if (!isCompany[msg.sender]) revert CompanyNotAllowed();
        if (s.receivedSet) revert AlreadyReported();

        s.received = FHE.fromExternal(receivedExt, proof);
        s.receivedSet = true;

        // Confidentiality: only receiver can decrypt received amount (besides the contract itself)
        FHE.allowThis(s.received);
        FHE.allow(s.received, s.receiver);

        emit ShipmentFieldReported(shipmentId, msg.sender);
        _tryVerifyShipment(shipmentId);
    }

    /// @notice Allows an extra address (e.g. an auditor) to decrypt shipment fields and verification.
    /// @dev Any of the 3 shipment participants can grant access.
    /// @param shipmentId The shipment id.
    /// @param auditor The auditor address to grant access to.
    function allowAuditorForShipment(uint256 shipmentId, address auditor) external {
        Shipment storage s = _shipments[shipmentId];
        _requireShipmentExists(s);
        _requireAuditorAllowed(auditor);
        _requireShipmentParticipant(s);
        _grantShipmentAuditorAccess(s, auditor);
    }

    /// @notice Reports encrypted mass-balance for the caller in a given period.
    /// @param period The reporting period.
    /// @param totalInExt The encrypted total input (external handle).
    /// @param totalOutExt The encrypted total output (external handle).
    /// @param processLossExt The encrypted process loss (external handle).
    /// @param proof The input proof.
    function reportMassBalanceForPeriod(
        uint256 period,
        externalEuint32 totalInExt,
        externalEuint32 totalOutExt,
        externalEuint32 processLossExt,
        bytes calldata proof
    ) external onlyCompany {
        MassBalanceReport storage r = _reports[msg.sender][period];

        r.totalIn = FHE.fromExternal(totalInExt, proof);
        r.totalOut = FHE.fromExternal(totalOutExt, proof);
        r.processLoss = FHE.fromExternal(processLossExt, proof);
        r.isSet = true;

        // balanced := totalIn == totalOut + processLoss
        r.balanced = FHE.eq(r.totalIn, FHE.add(r.totalOut, r.processLoss));

        // Confidentiality: only company can decrypt their report (besides the contract itself)
        FHE.allowThis(r.totalIn);
        FHE.allowThis(r.totalOut);
        FHE.allowThis(r.processLoss);
        FHE.allowThis(r.balanced);

        FHE.allow(r.totalIn, msg.sender);
        FHE.allow(r.totalOut, msg.sender);
        FHE.allow(r.processLoss, msg.sender);
        FHE.allow(r.balanced, msg.sender);

        emit MassBalanceReported(period, msg.sender);
    }

    /// @notice Returns a company's encrypted mass-balance report for a given period.
    /// @param company The company address.
    /// @param period The reporting period.
    /// @return totalIn The encrypted total input.
    /// @return totalOut The encrypted total output.
    /// @return processLoss The encrypted process loss.
    /// @return balanced The encrypted flag: totalIn == totalOut + processLoss.
    /// @return isSet Whether a report exists.
    function getMassBalanceReport(
        address company,
        uint256 period
    ) external view returns (euint32 totalIn, euint32 totalOut, euint32 processLoss, ebool balanced, bool isSet) {
        MassBalanceReport storage r = _reports[company][period];
        return (r.totalIn, r.totalOut, r.processLoss, r.balanced, r.isSet);
    }

    /// @notice Allows an extra address (e.g. an auditor) to decrypt a company's report for a period.
    /// @dev Only the company can grant access to its report.
    /// @param period The reporting period.
    /// @param auditor The auditor address to grant access to.
    function allowAuditorForReport(uint256 period, address auditor) external {
        if (auditor == address(0)) revert InvalidAddress();
        if (!isAuditor[auditor]) revert AuditorNotAllowed();
        MassBalanceReport storage r = _reports[msg.sender][period];
        if (!r.isSet) return;

        FHE.allow(r.totalIn, auditor);
        FHE.allow(r.totalOut, auditor);
        FHE.allow(r.processLoss, auditor);
        FHE.allow(r.balanced, auditor);
    }

    /// @notice Computes the shipment verification flag once all fields are reported.
    /// @param shipmentId The shipment id.
    function _tryVerifyShipment(uint256 shipmentId) internal {
        Shipment storage s = _shipments[shipmentId];
        _requireShipmentExists(s);
        if (!s.sentSet || !s.lossSet || !s.receivedSet) return;
        if (FHE.isInitialized(s.verified)) return;

        // verified := received == sent - transportLoss
        s.verified = FHE.eq(s.received, FHE.sub(s.sent, s.transportLoss));

        // All participants can decrypt the boolean "verified" flag.
        FHE.allowThis(s.verified);
        FHE.allow(s.verified, s.sender);
        FHE.allow(s.verified, s.transporter);
        FHE.allow(s.verified, s.receiver);

        emit ShipmentVerified(shipmentId);
    }

    /// @notice Reverts if a shipment does not exist.
    /// @param s Shipment storage reference.
    function _requireShipmentExists(Shipment storage s) internal view {
        if (s.sender == address(0)) revert ShipmentDoesNotExist();
    }

    /// @notice Reverts unless `auditor` is a non-zero approved auditor.
    /// @param auditor The auditor address.
    function _requireAuditorAllowed(address auditor) internal view {
        if (auditor == address(0)) revert InvalidAddress();
        if (!isAuditor[auditor]) revert AuditorNotAllowed();
    }

    /// @notice Contract version for upgrade demonstrations.
    /// @return v The contract version.
    function version() external pure returns (uint256 v) {
        return 1;
    }

    /// @notice Reverts unless `msg.sender` is one of the shipment participants.
    /// @param s Shipment storage reference.
    function _requireShipmentParticipant(Shipment storage s) internal view {
        if (msg.sender == s.sender) return;
        if (msg.sender == s.transporter) return;
        if (msg.sender == s.receiver) return;
        revert NotShipmentParticipant();
    }

    /// @notice Grants an auditor decryption permission for all available shipment fields.
    /// @param s Shipment storage reference.
    /// @param auditor The auditor address.
    function _grantShipmentAuditorAccess(Shipment storage s, address auditor) internal {
        if (s.sentSet) FHE.allow(s.sent, auditor);
        if (s.lossSet) FHE.allow(s.transportLoss, auditor);
        if (s.receivedSet) FHE.allow(s.received, auditor);
        if (FHE.isInitialized(s.verified)) FHE.allow(s.verified, auditor);
    }

    /// @notice UUPS authorization hook. Only the owner can upgrade.
    /// @param newImplementation The new implementation address.
    function _authorizeUpgrade(address newImplementation) internal view override onlyOwner {
        // silence unused var warning
        newImplementation;
    }
}
