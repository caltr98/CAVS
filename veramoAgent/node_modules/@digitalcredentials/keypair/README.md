# Cryptographic Key Pair _(@digitalcredentials/keypair)_

[![Build status](https://img.shields.io/github/actions/workflow/status/digitalcredentials/keypair/main.yml?branch=main)](https://github.com/digitalcredentials/keypair/actions?query=workflow%3A%22Node.js+CI%22)
[![NPM Version](https://img.shields.io/npm/v/@digitalcredentials/keypair.svg)](https://npm.im/@digitalcredentials/keypair)

> Cryptographic key pair data model in Javascript/Typescript, for Node.js, browsers, and React Native. Useful for Verifiable Credentials, DIDs (Decentralized Identifiers), and other uses of Data Integrity.

## Table of Contents

- [Background](#background)
- [Security](#security)
- [Install](#install)
- [Usage](#usage)
- [Contribute](#contribute)
- [License](#license)

## Background

Extracted from Digital Bazaar's [`crypto-ld`](https://github.com/digitalbazaar/crypto-ld)
library, and converted to Typescript.

This is an abstract key pair data model, meant to be used in individual subclass
key pair implementations, such as:

* [`ed25519-verification-key-2020`](https://github.com/digitalcredentials/ed25519-verification-key-2020)
* [`x25519-key-agreement-key-2020`](https://github.com/digitalcredentials/x25519-key-agreement-key-2020)
* [`rsa-verification-key-2018`](https://github.com/digitalcredentials/rsa-verification-key-2018)

### Choosing a Key Type

For digital signatures using the
[`linked-data-integrity`](https://github.com/digitalcredentials/linked-data-integrity) library,
signing of Verifiable Credentials using [`vc`](https://github.com/digitalcredentials/vc) library,
authorization capabilities, and DIDAuth operations:

* Prefer **Ed25519VerificationKey2020** type keys, by default.
* Use **EcdsaSepc256k1** keys if your use case requires it (for example, if
  you're developing for a Bitcoin-based or Ethereum-based ledger), or if you
  require Hierarchical Deterministic (HD) wallet functionality.

For key agreement protocols for encryption operations:

* Use **Curve25519** with the [`minimal-cipher`](https://github.com/digitalcredentials/minimal-cipher)
  library.

## Security

As with most security- and cryptography-related tools, the overall security of
your system will largely depend on your design decisions.

## Install

- Node.js 16+ is recommended.

### NPM

To install via NPM:

```
npm install @digitalcredentials/keypair
```

### Development

To install locally (for development):

```
git clone https://github.com/digitalcredentials/keypair.git
cd keypair
npm install
```

## Usage

This library is meant to be used only by implementers of new cryptographic key suite
libraries.

When adding support for a new suite type subclass of `keypair`, developers
should do the following:

1. Create their own npm package / github repo, such as `example-key-pair`.
2. Subclass KeyPair.
3. Override relevant methods (such as `export()` and `fingerprint()`).
4. Add to the key type table in the `crypto-suite-manager` README.md.

## Contribute

PRs accepted.

If editing the Readme, please conform to the
[standard-readme](https://github.com/RichardLitt/standard-readme) specification.

## License

[MIT License](LICENSE.md) © 2022 Digital Credentials Consortium.
