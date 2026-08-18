// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title CAVSOracleCoordinator
/// @notice Registry of DON oracle identities and encryption keys.
/// @dev The coordinator records which account controls each oracle slot and
///      publishes the oracle encryption key used by authors to wrap request
///      keys for blob-backed CAVS submissions.
contract CAVSOracleCoordinator {
    /// @notice Public view of an oracle registration.
    /// @dev active is derived from whether the slot has a non-zero account.
    struct OracleRegistration {
        uint8 oracleId;
        address account;
        string did;
        bytes32 oraclesEncryptionKey;
        bool active;
        uint64 updatedAt;
    }

    /// @notice Storage layout for one oracle slot.
    /// @dev oracleId is implicit in the mapping key.
    struct StoredOracleRegistration {
        address account;
        uint64 updatedAt;
        string did;
        bytes32 oraclesEncryptionKey;
    }

    /// @notice Reverse lookup from account to oracle slot.
    /// @dev registered distinguishes an unregistered account from slot 0.
    struct AccountRegistration {
        uint8 oracleId;
        bool registered;
    }

    uint8 public immutable oracleCount;

    mapping(uint8 => StoredOracleRegistration) private oracleById;
    mapping(address => AccountRegistration) private oracleByAccount;
    uint8[] private registeredOracleIds;

    error InvalidOracleCount();
    error DidRequired();
    error OraclesEncryptionKeyRequired();
    error OracleIdOutOfRange();
    error OracleIdAlreadyRegistered();
    error AccountAlreadyRegistered();
    error AccountNotRegistered();
    error CallerNotRegisteredOracle();

    /// @notice Emitted whenever an oracle slot is registered or refreshed.
    /// @dev Consumers use this event to observe DID/account/encryption-key
    ///      updates, while read paths use getOracle and getRegisteredOracleIds.
    event OracleRegistered(
        uint8 indexed oracleId,
        address indexed account,
        string did,
        bytes32 oraclesEncryptionKey
    );

    /// @notice Create a coordinator for a fixed-size DON.
    /// @dev Requires:
    ///      - oracleCount_ > 0.
    ///      Modifies:
    ///      - oracleCount immutable value.
    ///      Effects:
    ///      - fixes the valid oracle id range to [0, oracleCount_).
    constructor(uint8 oracleCount_) {
        if (oracleCount_ == 0) revert InvalidOracleCount();
        oracleCount = oracleCount_;
    }

    /// @notice Restrict a function to an account already registered as an oracle.
    /// @dev Requires:
    ///      - msg.sender has an AccountRegistration with registered == true.
    modifier onlyRegisteredOracle() {
        if (!oracleByAccount[msg.sender].registered) {
            revert CallerNotRegisteredOracle();
        }
        _;
    }

    /// @notice Register or refresh the caller's oracle slot.
    /// @dev Requires:
    ///      - oracleId < oracleCount;
    ///      - did is non-empty;
    ///      - oraclesEncryptionKey is non-zero;
    ///      - if msg.sender is already registered, it is registered for oracleId;
    ///      - if oracleId is already occupied, it is occupied by msg.sender.
    ///      Modifies:
    ///      - oracleByAccount[msg.sender];
    ///      - oracleById[oracleId];
    ///      - registeredOracleIds when msg.sender registers for the first time.
    ///      Effects:
    ///      - binds msg.sender to oracleId if needed;
    ///      - stores the DID and oracle encryption key for the slot;
    ///      - updates the registration timestamp;
    ///      - emits OracleRegistered.
    function registerOracle(
        uint8 oracleId,
        string calldata did,
        bytes32 oraclesEncryptionKey
    ) external {
        if (oracleId >= oracleCount) revert OracleIdOutOfRange();
        if (bytes(did).length == 0) revert DidRequired();
        if (oraclesEncryptionKey == bytes32(0)) revert OraclesEncryptionKeyRequired();

        AccountRegistration storage accountRegistration = oracleByAccount[msg.sender];
        if (accountRegistration.registered) {
            if (accountRegistration.oracleId != oracleId) revert AccountAlreadyRegistered();
        }

        StoredOracleRegistration storage current = oracleById[oracleId];
        if (current.account != address(0) && current.account != msg.sender) {
            revert OracleIdAlreadyRegistered();
        }
        if (!accountRegistration.registered) {
            registeredOracleIds.push(oracleId);
            accountRegistration.oracleId = oracleId;
            accountRegistration.registered = true;
        }

        current.account = msg.sender;
        current.updatedAt = uint64(block.timestamp);
        current.did = did;
        current.oraclesEncryptionKey = oraclesEncryptionKey;

        emit OracleRegistered(oracleId, msg.sender, did, oraclesEncryptionKey);
    }

    /// @notice Return the number of oracle ids that have been registered.
    /// @dev Requires: none.
    ///      Modifies: nothing.
    ///      Effects: returns registeredOracleIds.length.
    function registeredOracleCount() external view returns (uint256) {
        return registeredOracleIds.length;
    }

    /// @notice Read one oracle slot.
    /// @dev Requires:
    ///      - oracleId < oracleCount.
    ///      Modifies: nothing.
    ///      Effects:
    ///      - returns the account, DID, encryption key, active flag, and update
    ///        timestamp for oracleId.
    function getOracle(uint8 oracleId) external view returns (OracleRegistration memory) {
        if (oracleId >= oracleCount) revert OracleIdOutOfRange();
        StoredOracleRegistration storage current = oracleById[oracleId];
        address account = current.account;
        return OracleRegistration({
            oracleId: oracleId,
            account: account,
            did: current.did,
            oraclesEncryptionKey: current.oraclesEncryptionKey,
            active: account != address(0),
            updatedAt: current.updatedAt
        });
    }

    /// @notice Return all oracle ids that have ever been registered.
    /// @dev Requires: none.
    ///      Modifies: nothing.
    ///      Effects: returns registeredOracleIds in registration order.
    function getRegisteredOracleIds() external view returns (uint8[] memory) {
        return registeredOracleIds;
    }

    /// @notice Check whether an account is registered as an oracle.
    /// @dev Requires: none.
    ///      Modifies: nothing.
    ///      Effects: returns oracleByAccount[account].registered.
    function isRegisteredOracle(address account) external view returns (bool) {
        return oracleByAccount[account].registered;
    }

    /// @notice Return the oracle id controlled by an account.
    /// @dev Requires:
    ///      - account is registered.
    ///      Modifies: nothing.
    ///      Effects: returns oracleByAccount[account].oracleId.
    function getOracleIdForAccount(address account) external view returns (uint8) {
        AccountRegistration storage accountRegistration = oracleByAccount[account];
        if (!accountRegistration.registered) revert AccountNotRegistered();
        return accountRegistration.oracleId;
    }

    /// @notice Assert that msg.sender is a registered oracle and return its id.
    /// @dev Requires:
    ///      - msg.sender is registered.
    ///      Modifies: nothing.
    ///      Effects: returns oracleByAccount[msg.sender].oracleId.
    function requireRegisteredOracleAccount() external view onlyRegisteredOracle returns (uint8 oracleId) {
        return oracleByAccount[msg.sender].oracleId;
    }
}
