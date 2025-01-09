# @transmute/jsonld
[![CI](https://github.com/transmute-industries/jsonld/actions/workflows/ci.yml/badge.svg)](https://github.com/transmute-industries/jsonld/actions/workflows/ci.yml)
![Branches](./badges/coverage-branches.svg)
![Functions](./badges/coverage-functions.svg)
![Lines](./badges/coverage-lines.svg)
![Statements](./badges/coverage-statements.svg)
![Jest coverage](./badges/coverage-jest%20coverage.svg)
[![NPM](https://nodei.co/npm/@transmute/jsonld.png?mini=true)](https://npmjs.org/package/@transmute/jsonld)

<img src="./transmute-banner.png" />

This package is a wrapper around the original `jsonld` package published by digitalbazaar as found here: https://www.npmjs.com/package/jsonld

This package contains all of the same functions in addition to a newly added `safeCanonize` function that will prevent you from canonizing data that is not properly formatted JSON-LD.


## Installation

To install simply run:

```
npm i @transmute/jsonld
```
