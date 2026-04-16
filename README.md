# Confidential Supply Chain

A Hardhat-based project implementing a **confidential supply chain management system** using Zama's [FHEVM](https://docs.zama.ai/fhevm) (Fully Homomorphic Encryption Virtual Machine). Shipment values and mass-balance reports stay encrypted on-chain; participants decrypt only their own data, and auditors receive selective access.

> **Disclaimer:** This is a personal, educational project and is not an official Zama product or endorsed by Zama in any way. It is intended for learning and experimentation purposes only.

---

## Overview

Traditional supply chain contracts expose all data to every on-chain observer. This project shows how FHEVM lets you:

- Record encrypted shipment quantities (sent, transport loss, received) where each role sees only its own values.
- Automatically verify on-chain that `received == sent − transportLoss` without decrypting the operands.
- Aggregate per-period encrypted mass-balance reports and verify that `totalIn == totalOut + processLoss`.
- Grant auditors selective decryption access to individual shipments or company reports.

The contract is deployed as a **UUPS upgradeable proxy** on the Sepolia testnet.

---

## How It Works

### Roles

| Role | Responsibilities |
|------|-----------------|
| **Owner** | Manages company and auditor allowlists; can upgrade the contract |
| **Company (Sender)** | Creates shipments; encrypts and reports the sent amount |
| **Company (Transporter)** | Encrypts and reports transport loss for a shipment |
| **Company (Receiver)** | Encrypts and reports the received amount; submits mass-balance reports |
| **Auditor** | Granted selective decrypt access by participants; reads encrypted values |

### Shipment Flow

```
Sender          Transporter        Receiver
  │                  │                │
  ├─ createShipment ─►                │
  │                  │                │
  ├─ reportSent ─────►                │
  │                  │                │
  │                  ├─ reportTransportLoss
  │                  │                │
  │                  │                ├─ reportReceived
  │                  │                │
  └──────────── verified flag computed on-chain (encrypted) ────────────────►
```

Once all three values are reported, the contract computes an encrypted `verified` flag: `received == sent − transportLoss`.

### Mass-Balance Flow

A company calls `reportMassBalanceForPeriod(period, totalIn, totalOut, processLoss)`. The contract stores the values encrypted and computes `balanced = (totalIn == totalOut + processLoss)` without revealing the amounts.

---

## Contract: `ConfidentialSupplyChain`

**Location:** [contracts/ConfidentialSupplyChain.sol](contracts/ConfidentialSupplyChain.sol)

### Key Functions

| Function | Caller | Description |
|----------|--------|-------------|
| `initialize(periodDuration)` | Owner (deploy) | Sets period duration; initializes FHEVM |
| `setCompany(address, bool)` | Owner | Add/remove a company from the allowlist |
| `setAuditor(address, bool)` | Owner | Add/remove an auditor from the allowlist |
| `createShipment(transporter, receiver)` | Company | Creates a new shipment; returns `shipmentId` |
| `reportSent(shipmentId, encValue, proof)` | Sender | Reports encrypted sent amount |
| `reportTransportLoss(shipmentId, encValue, proof)` | Transporter | Reports encrypted transport loss |
| `reportReceived(shipmentId, encValue, proof)` | Receiver | Reports encrypted received amount |
| `allowAuditorForShipment(shipmentId, auditor)` | Participant | Grants auditor decryption access |
| `reportMassBalanceForPeriod(period, in, out, loss, proof)` | Company | Reports encrypted mass balance for a period |
| `allowAuditorForReport(period, auditor)` | Company | Grants auditor access to a report |
| `currentPeriod()` | Anyone | Returns current period (`block.timestamp / periodDuration`) |

### Events

- `ShipmentCreated(shipmentId, period, sender, transporter, receiver)`
- `ShipmentFieldReported(shipmentId, reporter)`
- `ShipmentVerified(shipmentId)`
- `MassBalanceReported(period, company)`
- `CompanyAllowlistUpdated(company, allowed)`
- `AuditorAllowlistUpdated(auditor, allowed)`

---

## Project Structure

```
confidential-supply-chain/
├── contracts/
│   └── ConfidentialSupplyChain.sol      # Main FHEVM contract
├── deploy/
│   └── deployConfidentialSupplyChain.ts # hardhat-deploy UUPS proxy deployment
├── scripts/
│   └── sepolia/                         # Step-by-step scripts for Sepolia testnet
│       ├── _utils.ts                    # Shared CLI helpers and .env loader
│       ├── setupAllowlists.ts           # Owner: configure allowlists
│       ├── createShipment.ts            # Create a shipment
│       ├── reportSent.ts                # Sender: encrypt + report sent amount
│       ├── reportTransportLoss.ts       # Transporter: encrypt + report loss
│       ├── reportReceived.ts            # Receiver: encrypt + report received
│       ├── decryptShipment.ts           # Company: decrypt shipment values
│       ├── auditorShipment.ts           # Auditor: grant access + decrypt
│       ├── reportMassBalance.ts         # Report encrypted mass balance
│       ├── decryptMassBalance.ts        # Company: decrypt mass-balance report
│       ├── grantAuditorForMassBalance.ts# Company: grant auditor access to report
│       └── decryptMassBalanceAsAuditor.ts # Auditor: decrypt company report
├── tasks/
│   └── ConfidentialSupplyChain.ts       # Hardhat tasks: deploy, upgrade, verify
├── test/
│   └── ConfidentialSupplyChain.demo.ts  # Mocha test suite (FHEVM mock)
├── docs/
│   └── sepolia-scripts.md               # Step-by-step Sepolia walkthrough
├── hardhat.config.ts
└── package.json
```

---

## Prerequisites

- **Node.js** >= 20
- **npm** >= 7

---

## Getting Started

### 1. Install dependencies

```bash
npm install
```

### 2. Set Hardhat variables

```bash
npx hardhat vars set MNEMONIC
npx hardhat vars set INFURA_API_KEY
npx hardhat vars set ETHERSCAN_API_KEY   # optional, for verification
```

### 3. Compile

```bash
npm run compile
```

### 4. Run tests (local FHEVM mock)

```bash
npm run test
```

### 5. Deploy locally

```bash
npx hardhat node
npx hardhat deploy --network localhost
```

### 6. Deploy to Sepolia

```bash
# Deploy via custom task (sets period duration)
npx hardhat csc:deploy --network sepolia --period 604800

# Verify on Etherscan
npx hardhat csc:verify --network sepolia --proxy <PROXY_ADDRESS>
```

---

## Running Sepolia Scripts

Copy `.env.example` to `.env` and fill in the deployed proxy address and private keys:

```bash
CSC_PROXY_ADDRESS=0x...
OWNER_PRIVATE_KEY=0x...
SENDER_PRIVATE_KEY=0x...
TRANSPORTER_PRIVATE_KEY=0x...
RECEIVER_PRIVATE_KEY=0x...
AUDITOR_PRIVATE_KEY=0x...   # optional
```

See [docs/sepolia-scripts.md](docs/sepolia-scripts.md) for the full step-by-step walkthrough with copy-paste commands.

A typical flow:

```bash
# 1. Allowlist participants
npx ts-node scripts/sepolia/setupAllowlists.ts --contract $CSC_PROXY_ADDRESS

# 2. Create a shipment
npx ts-node scripts/sepolia/createShipment.ts --contract $CSC_PROXY_ADDRESS

# 3. Report values (each party uses their own key)
npx ts-node scripts/sepolia/reportSent.ts           --contract $CSC_PROXY_ADDRESS --shipment-id 0 --sent 1000
npx ts-node scripts/sepolia/reportTransportLoss.ts  --contract $CSC_PROXY_ADDRESS --shipment-id 0 --loss 50
npx ts-node scripts/sepolia/reportReceived.ts       --contract $CSC_PROXY_ADDRESS --shipment-id 0 --received 950

# 4. Decrypt (each party sees only their own values)
npx ts-node scripts/sepolia/decryptShipment.ts --contract $CSC_PROXY_ADDRESS --shipment-id 0 --role sender

# 5. Auditor flow
npx ts-node scripts/sepolia/auditorShipment.ts --contract $CSC_PROXY_ADDRESS --shipment-id 0 --role receiver
```

---

## Available npm Scripts

| Script | Description |
|--------|-------------|
| `npm run compile` | Compile contracts and generate TypeChain types |
| `npm run test` | Run all tests against local FHEVM mock |
| `npm run coverage` | Generate Solidity coverage report |
| `npm run lint` | Run ESLint + Solhint |
| `npm run clean` | Remove build artifacts |

---

## Tech Stack

- **Smart Contracts:** Solidity 0.8.27, FHEVM (`@fhevm/solidity`), OpenZeppelin Upgradeable
- **Development:** Hardhat, hardhat-deploy, TypeScript
- **Encryption:** `@zama-fhe/relayer-sdk` (client-side encryption for Sepolia scripts)
- **Testing:** Mocha, Chai, `@fhevm/hardhat-plugin` (mock FHEVM)

---

## Documentation

- [FHEVM Documentation](https://docs.zama.ai/fhevm)
- [FHEVM Hardhat Setup Guide](https://docs.zama.ai/protocol/solidity-guides/getting-started/setup)
- [Sepolia Scripts Walkthrough](docs/sepolia-scripts.md)

---

## License

BSD-3-Clause-Clear. See [LICENSE](LICENSE) for details.
