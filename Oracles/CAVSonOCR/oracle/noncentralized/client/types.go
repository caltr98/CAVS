package client

type Config struct {
	RPCURL               string
	ContractAddress      string
	CAVSURL              string
	OracleID             int
	DID                  string
	OraclesEncryptionKey [32]byte
}

type OracleRegistration struct {
	OracleID             int
	Account              string
	DID                  string
	OraclesEncryptionKey string
	Active               bool
	UpdatedAt            uint64
}

type DeployResult struct {
	ContractAddress        string
	RequestRegistryAddress string
	TransactionHash        string
	CoordinatorTxHash      string
	RequestRegistryTxHash  string
	OracleCount            int
	Deployer               string
}

type RegisterResult struct {
	OracleID         int
	Account          string
	DID              string
	Noop             bool
	TransactionHash  string
}
