// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

contract CAVSOracleCoordinator {
    struct OracleRegistration {
        uint8 oracleId;
        address account;
        string did;
        string endpoint;
        bool active;
        uint64 updatedAt;
    }

    struct StoredOracleRegistration {
        address account;
        uint64 updatedAt;
        string did;
        string endpoint;
    }

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
    error EndpointRequired();
    error OracleIdOutOfRange();
    error OracleIdAlreadyRegistered();
    error AccountAlreadyRegistered();
    error AccountNotRegistered();
    error CallerNotRegisteredOracle();

    event OracleRegistered(
        uint8 indexed oracleId,
        address indexed account,
        string did,
        string endpoint
    );

    constructor(uint8 oracleCount_) {
        if (oracleCount_ == 0) revert InvalidOracleCount();
        oracleCount = oracleCount_;
    }

    modifier onlyRegisteredOracle() {
        if (!oracleByAccount[msg.sender].registered) {
            revert CallerNotRegisteredOracle();
        }
        _;
    }

    function registerOracle(
        uint8 oracleId,
        string calldata did,
        string calldata endpoint
    ) external {
        if (oracleId >= oracleCount) revert OracleIdOutOfRange();
        if (bytes(did).length == 0) revert DidRequired();
        if (bytes(endpoint).length == 0) revert EndpointRequired();

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
        current.endpoint = endpoint;

        emit OracleRegistered(oracleId, msg.sender, did, endpoint);
    }

    function registeredOracleCount() external view returns (uint256) {
        return registeredOracleIds.length;
    }

    function getOracle(uint8 oracleId) external view returns (OracleRegistration memory) {
        if (oracleId >= oracleCount) revert OracleIdOutOfRange();
        StoredOracleRegistration storage current = oracleById[oracleId];
        address account = current.account;
        return OracleRegistration({
            oracleId: oracleId,
            account: account,
            did: current.did,
            endpoint: current.endpoint,
            active: account != address(0),
            updatedAt: current.updatedAt
        });
    }

    function getRegisteredOracleIds() external view returns (uint8[] memory) {
        return registeredOracleIds;
    }

    function isRegisteredOracle(address account) external view returns (bool) {
        return oracleByAccount[account].registered;
    }

    function getOracleIdForAccount(address account) external view returns (uint8) {
        AccountRegistration storage accountRegistration = oracleByAccount[account];
        if (!accountRegistration.registered) revert AccountNotRegistered();
        return accountRegistration.oracleId;
    }

    function requireRegisteredOracleAccount() external view onlyRegisteredOracle returns (uint8 oracleId) {
        return oracleByAccount[msg.sender].oracleId;
    }
}
