// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title CAVSRequestRegistry
/// @notice Blob-backed request registry used as the on-chain Oracle Queue.
/// @dev The contract does not store plaintext requests and does not maintain a
///      physical FIFO data structure. Request discovery order is given by the
///      canonical order of emitted CAVSRequestSubmitted logs.
contract CAVSRequestRegistry {
    /// @notice Per-oracle envelope that lets one oracle recover the request key.
    /// @dev The envelope is public metadata. The wrapped key can only be opened
    ///      by the oracle owning the matching decryption key.
    struct KeyEnvelope {
        uint8 oracleId;
        bytes32 ephemeralPublicKey;
        bytes12 nonce;
        bytes wrappedARequestKey;
    }

    /// @dev Request metadata and per-oracle envelopes are emitted in
    ///      CAVSRequestSubmitted. Storage only tracks uniqueness.
    mapping(bytes32 => bool) private submittedRequestIDs;

    error MissingBlobHash();
    error DuplicateRequestID();
    error MissingKeyEnvelopes();

    /// @notice Emitted when a blob-backed request is accepted by the registry.
    /// @dev Consumers use this event as the request discovery stream. Logs are
    ///      ordered by (blockNumber, txIndex, logIndex).
    event CAVSRequestSubmitted(
        bytes32 indexed requestID,
        bytes32 indexed oracleSetID,
        address indexed requester,
        uint64 nonce,
        uint64 deadline,
        bytes32 blobHash,
        KeyEnvelope[] keyEnvelopes
    );

    /// @notice Submit a CAVS request whose encrypted payload is in blob 0.
    /// @dev Requires:
    ///      - the current transaction is a blob transaction with a non-zero
    ///        versioned hash at index 0;
    ///      - requestID has not already been submitted;
    ///      - keyEnvelopes is non-empty.
    ///      Modifies:
    ///      - submittedRequestIDs[requestID].
    ///      Effects:
    ///      - reads blobhash(0) and emits it with the request event;
    ///      - records requestID as submitted;
    ///      - emits CAVSRequestSubmitted.
    function submitBlobRequest(
        bytes32 requestID,
        bytes32 oracleSetID,
        uint64 nonce,
        uint64 deadline,
        KeyEnvelope[] calldata keyEnvelopes
    ) external {
        bytes32 blobHash;
        assembly {
            blobHash := blobhash(0)
        }
        if (blobHash == bytes32(0)) revert MissingBlobHash();
        _submit(
            requestID,
            oracleSetID,
            nonce,
            deadline,
            blobHash,
            keyEnvelopes
        );
    }

    /// @notice Internal implementation for accepting a request commitment.
    /// @dev Requires:
    ///      - submittedRequestIDs[requestID] is false;
    ///      - keyEnvelopes is non-empty;
    ///      - blobHash was already obtained by the caller.
    ///      Modifies:
    ///      - submittedRequestIDs[requestID].
    ///      Effects:
    ///      - records requestID as submitted;
    ///      - emits CAVSRequestSubmitted.
    function _submit(
        bytes32 requestID,
        bytes32 oracleSetID,
        uint64 nonce,
        uint64 deadline,
        bytes32 blobHash,
        KeyEnvelope[] calldata keyEnvelopes
    ) internal {
        if (submittedRequestIDs[requestID])
            revert DuplicateRequestID();
        if (keyEnvelopes.length == 0) revert MissingKeyEnvelopes();
        submittedRequestIDs[requestID] = true;
        emit CAVSRequestSubmitted(
            requestID,
            oracleSetID,
            msg.sender,
            nonce,
            deadline,
            blobHash,
            keyEnvelopes
        );
    }
}
