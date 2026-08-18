// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "../CAVSRequestRegistry.sol";

contract CAVSRequestRegistryHarness is CAVSRequestRegistry {
    function submitTestBlobRequest(
        bytes32 requestID,
        bytes32 oracleSetID,
        uint64 nonce,
        uint64 deadline,
        bytes32 blobHash,
        KeyEnvelope[] calldata keyEnvelopes
    ) external {
        _submit(requestID, oracleSetID, nonce, deadline, blobHash, keyEnvelopes);
    }
}
