package client

type Config struct {
	RPCURL          string
	ContractAddress string
	CAVSURL         string
	OracleID        int
	DID             string
	Endpoint        string
}

type OracleRegistration struct {
	OracleID  int
	Account   string
	DID       string
	Endpoint  string
	Active    bool
	UpdatedAt uint64
}
