## Sepolia scripts: one script per step

These scripts run against a deployed `ConfidentialSupplyChain` proxy on Sepolia. Each step has its own script.

### Scripts

- **Setup allowlists (owner-only)**: `scripts/sepolia/setupAllowlists.ts`
- **Create shipment + print details**: `scripts/sepolia/createShipment.ts`
- **Report sent**: `scripts/sepolia/reportSent.ts`
- **Report transport loss**: `scripts/sepolia/reportTransportLoss.ts`
- **Report received**: `scripts/sepolia/reportReceived.ts`
- **Decrypt shipment as companies**: `scripts/sepolia/decryptShipment.ts`
- **Shipment auditor (grant + decrypt)**: `scripts/sepolia/auditorShipment.ts`
- **Report mass balance**: `scripts/sepolia/reportMassBalance.ts`
- **Decrypt mass balance as company**: `scripts/sepolia/decryptMassBalance.ts`
- **Mass-balance auditor grant (company)**: `scripts/sepolia/grantAuditorForMassBalance.ts`
- **Mass-balance auditor decrypt (auditor)**: `scripts/sepolia/decryptMassBalanceAsAuditor.ts`

These scripts:

- Use **private keys** (not mnemonics)
- Load keys from `.env` in the repo root
- Accept **different inputs** via CLI flags
- Print the encrypted **handles** and **inputProof** values (useful for manual testing)

### Prerequisites

- **Node.js 20+**
- Dependencies installed:

```bash
npm install
```

- Sepolia RPC configured (this project uses Hardhat vars):

```bash
npx hardhat vars set INFURA_API_KEY
```

### 1) Create `.env`

Create a `.env` file at the repo root (do not commit it):

```bash
# Deployed proxy address (used by default)
CSC_PROXY_ADDRESS=0xYourProxyAddress

# Companies (private keys)
SENDER_PRIVATE_KEY=0x...
TRANSPORTER_PRIVATE_KEY=0x...
RECEIVER_PRIVATE_KEY=0x...

# Owner (for allowlist setup)
OWNER_PRIVATE_KEY=0x...

# Auditor (optional, only needed for auditor scripts)
AUDITOR_PRIVATE_KEY=0x...
```

Notes:

- You can override the `.env` address per-run by passing `--contract 0x...` (optional).

### 1) Setup allowlists (if not already set)

```bash
npx hardhat run --network sepolia scripts/sepolia/setupAllowlists.ts
```

### 2) Create a shipment + print details

```bash
npx hardhat run --network sepolia scripts/sepolia/createShipment.ts
```

### 3) Report `sent`

Runs:

1. encrypt `sent` as the sender
2. sender calls `reportSent(shipmentId, handle, proof)`

Command:

```bash
SHIPMENT_ID=0 SENT=100 npx hardhat run --network sepolia scripts/sepolia/reportSent.ts
```

### 4) Report `transportLoss`

Runs:

1. encrypt `loss` as the transporter
2. transporter calls `reportTransportLoss(shipmentId, handle, proof)`

Command:

```bash
SHIPMENT_ID=0 LOSS=3 npx hardhat run --network sepolia scripts/sepolia/reportTransportLoss.ts
```

### 5) Report `received`

Runs:

1. encrypt `received` as the receiver
2. receiver calls `reportReceived(shipmentId, handle, proof)`

Command:

```bash
SHIPMENT_ID=0 RECEIVED=97 npx hardhat run --network sepolia scripts/sepolia/reportReceived.ts
```

### 6) Decrypt shipment as each company

This script:

- reads the shipment handles via `getShipment(shipmentId)`
- decrypts `verified` as sender + transporter + receiver (should succeed for all 3)
- tries to decrypt sender’s `sent` as receiver (should fail)
- decrypts sender’s `sent` as sender (should succeed)

Command:

```bash
SHIPMENT_ID=0 npx hardhat run --network sepolia scripts/sepolia/decryptShipment.ts
```

### 7) Shipment auditor (grant + decrypt)

```bash
COMPANY_ROLE=sender SHIPMENT_ID=0 npx hardhat run --network sepolia scripts/sepolia/auditorShipment.ts
```

### 8) Report mass-balance

Set these env vars for the report:

- `PERIOD` (optional): if omitted, uses `currentPeriod()`
- `TOTAL_IN`, `TOTAL_OUT`, `PROCESS_LOSS`

Command:

```bash
TOTAL_IN=97 TOTAL_OUT=96 PROCESS_LOSS=1 npx hardhat run --network sepolia scripts/sepolia/reportMassBalance.ts
```

### 9) Decrypt mass-balance (company)

This script decrypts using the company wallet selected via `COMPANY_ROLE` (e.g. `receiver`) and prints:

- `balanced`
- `totalIn`, `totalOut`, `processLoss`

Command:

```bash
COMPANY_ROLE=receiver npx hardhat run --network sepolia scripts/sepolia/decryptMassBalance.ts
```

### 10) Auditor: grant access + decrypt mass-balance

This is a 2-step flow (separate scripts):

1. **Grant access** (run as the company)
2. **Decrypt** (run as the auditor)

Required:

- `AUDITOR_PRIVATE_KEY` in `.env`
- auditor must already be allowlisted in the contract (`isAuditor[auditor] == true`)

Notes:

- `REPORTING_COMPANY_ROLE` selects **which company’s report** the auditor is decrypting (e.g. `receiver`).
- The decryption itself is always done using `AUDITOR_PRIVATE_KEY`.

Step 1: grant (company):

```bash
REPORTING_COMPANY_ROLE=receiver npx hardhat run --network sepolia scripts/sepolia/grantAuditorForMassBalance.ts
```

Step 2: decrypt (auditor):

```bash
REPORTING_COMPANY_ROLE=receiver npx hardhat run --network sepolia scripts/sepolia/decryptMassBalanceAsAuditor.ts
```

### Troubleshooting

- **Revert: `CompanyNotAllowed` / `AuditorNotAllowed`**:
  - Ensure the involved addresses are allowlisted on-chain via `setCompany` / `setAuditor` (owner-only).
- **Missing contract address**:
  - Set `CSC_PROXY_ADDRESS` in `.env` (recommended), or pass `--contract 0x...` to override.
