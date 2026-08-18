# Noncentralized Oracle Backend

This directory contains the registry and client code used by the
`smart-contract` deployment mode in `CAVSonOCR`.

## Folders

- `hardhat/`
  Solidity contract, deployment scripts, tests, and generated artifacts.
- `client/`
  Go client and bindings used by oracle nodes to register themselves.

## What The Contract Stores

- configured oracle slot count
- oracle slot registrations
- per-slot DID and endpoint data
- sender address for each slot

## What Stays Off-Chain

- request bodies
- oracle observations
- final result payloads

Requesters resolve oracle endpoints from the registry and send requests to the
per-oracle HTTP queues directly.

## Rules

- `ORACLE_ID` must be in `0..NUM_ORACLES-1`.
- `NUM_ORACLES` must be in `1..255`.
- Each oracle must register the same `ORACLE_ID` it uses in OCR.
- A slot can be updated only by the account that registered it first.
- Live-network deployments need enough ETH on the Veramo-managed oracle
  addresses to pay gas.
