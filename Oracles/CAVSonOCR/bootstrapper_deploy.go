//go:build !queue

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	noncentralizedclient "cavs/cavsonocr/oracle/noncentralized/client"
	contractbindings "cavs/cavsonocr/oracle/noncentralized/client/contracts"
	"github.com/ethereum/go-ethereum/accounts/abi/bind"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/ethclient"
)

type contractDeployment struct {
	ContractAddress        string `json:"contract_address"`
	RequestRegistryAddress string `json:"request_registry_address,omitempty"`
	TransactionHash        string `json:"transaction_hash,omitempty"`
	CoordinatorTxHash      string `json:"coordinator_tx_hash,omitempty"`
	RequestRegistryTxHash  string `json:"request_registry_tx_hash,omitempty"`
	OracleCount            int    `json:"oracle_count,omitempty"`
	Deployer               string `json:"deployer,omitempty"`
	Source                 string `json:"source,omitempty"`
}

type oracleRegistrationDeployment struct {
	OracleID        int    `json:"oracle_id"`
	Account         string `json:"account,omitempty"`
	DID             string `json:"did,omitempty"`
	TransactionHash string `json:"transaction_hash,omitempty"`
	RecordedAt      string `json:"recorded_at,omitempty"`
}

type bootstrapContractDeploymentRequest struct {
	RegistryDir     string
	OracleCount     int
	ContractRPCURL  string
	ContractAddress string
	CAVSURL         string
	Deployer        didRegistryEntry
}

func contractDeploymentFile(dir string) string {
	return filepath.Join(dir, "ocr-contract-deployment.json")
}

func oracleRegistrationDeploymentFile(dir string, oracleID int) string {
	return filepath.Join(dir, fmt.Sprintf("ocr-oracle-%d-registration.json", oracleID))
}

func writeContractDeployment(dir string, deployment contractDeployment) error {
	if !common.IsHexAddress(strings.TrimSpace(deployment.ContractAddress)) {
		return fmt.Errorf("invalid contract address %q", deployment.ContractAddress)
	}
	deployment.ContractAddress = common.HexToAddress(deployment.ContractAddress).Hex()
	if strings.TrimSpace(deployment.RequestRegistryAddress) != "" {
		if !common.IsHexAddress(strings.TrimSpace(deployment.RequestRegistryAddress)) {
			return fmt.Errorf("invalid request registry address %q", deployment.RequestRegistryAddress)
		}
		deployment.RequestRegistryAddress = common.HexToAddress(deployment.RequestRegistryAddress).Hex()
	}
	if strings.TrimSpace(deployment.CoordinatorTxHash) == "" {
		deployment.CoordinatorTxHash = strings.TrimSpace(deployment.TransactionHash)
	}
	if strings.TrimSpace(deployment.TransactionHash) == "" {
		deployment.TransactionHash = strings.TrimSpace(deployment.CoordinatorTxHash)
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(deployment, "", "  ")
	if err != nil {
		return err
	}
	path := contractDeploymentFile(dir)
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, append(data, '\n'), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func tryReadContractDeployment(dir string) (contractDeployment, bool, error) {
	path := contractDeploymentFile(dir)
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return contractDeployment{}, false, nil
		}
		return contractDeployment{}, false, err
	}
	var deployment contractDeployment
	if err := json.Unmarshal(data, &deployment); err != nil {
		return contractDeployment{}, false, fmt.Errorf("decode %s: %w", path, err)
	}
	if !common.IsHexAddress(strings.TrimSpace(deployment.ContractAddress)) {
		return contractDeployment{}, false, fmt.Errorf("%s has invalid contract_address %q", path, deployment.ContractAddress)
	}
	deployment.ContractAddress = common.HexToAddress(deployment.ContractAddress).Hex()
	if strings.TrimSpace(deployment.RequestRegistryAddress) != "" {
		if !common.IsHexAddress(strings.TrimSpace(deployment.RequestRegistryAddress)) {
			return contractDeployment{}, false, fmt.Errorf("%s has invalid request_registry_address %q", path, deployment.RequestRegistryAddress)
		}
		deployment.RequestRegistryAddress = common.HexToAddress(deployment.RequestRegistryAddress).Hex()
	}
	if strings.TrimSpace(deployment.CoordinatorTxHash) == "" {
		deployment.CoordinatorTxHash = strings.TrimSpace(deployment.TransactionHash)
	}
	if strings.TrimSpace(deployment.TransactionHash) == "" {
		deployment.TransactionHash = strings.TrimSpace(deployment.CoordinatorTxHash)
	}
	return deployment, true, nil
}

func writeOracleRegistrationDeployment(dir string, registration oracleRegistrationDeployment) error {
	if registration.OracleID < 0 {
		return fmt.Errorf("invalid oracle id %d", registration.OracleID)
	}
	if strings.TrimSpace(registration.RecordedAt) == "" {
		registration.RecordedAt = time.Now().UTC().Format(time.RFC3339Nano)
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(registration, "", "  ")
	if err != nil {
		return err
	}
	path := oracleRegistrationDeploymentFile(dir, registration.OracleID)
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, append(data, '\n'), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func waitForContractDeployment(ctx context.Context, dir string, timeout time.Duration) (contractDeployment, error) {
	waitCtx := ctx
	if timeout > 0 {
		var cancel context.CancelFunc
		waitCtx, cancel = context.WithTimeout(ctx, timeout)
		defer cancel()
	}
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()

	for {
		deployment, ok, err := tryReadContractDeployment(dir)
		if err == nil && ok {
			return deployment, nil
		}
		select {
		case <-waitCtx.Done():
			if err != nil {
				return contractDeployment{}, err
			}
			return contractDeployment{}, fmt.Errorf("timed out waiting for contract deployment in %s", dir)
		case <-ticker.C:
		}
	}
}

func validateCoordinatorDeployment(ctx context.Context, rpcURL string, contractAddress string, expectedOracleCount int) error {
	if strings.TrimSpace(rpcURL) == "" {
		return nil
	}
	if !common.IsHexAddress(strings.TrimSpace(contractAddress)) {
		return fmt.Errorf("invalid contract address %q", contractAddress)
	}

	eth, err := ethclient.DialContext(ctx, strings.TrimSpace(rpcURL))
	if err != nil {
		return fmt.Errorf("dial eth client: %w", err)
	}
	defer eth.Close()

	coordinator, err := contractbindings.NewCAVSOracleCoordinatorCaller(common.HexToAddress(contractAddress), eth)
	if err != nil {
		return fmt.Errorf("bind coordinator: %w", err)
	}

	callOpts := &bind.CallOpts{Context: ctx}
	oracleCount, err := coordinator.OracleCount(callOpts)
	if err != nil {
		return fmt.Errorf("oracleCount probe failed: %w", err)
	}
	if oracleCount == 0 {
		return fmt.Errorf("oracleCount probe returned zero")
	}
	if expectedOracleCount > 0 && int(oracleCount) != expectedOracleCount {
		return fmt.Errorf("oracleCount mismatch: chain=%d expected=%d", oracleCount, expectedOracleCount)
	}
	if _, err := coordinator.IsRegisteredOracle(callOpts, common.Address{}); err != nil {
		return fmt.Errorf("isRegisteredOracle probe failed: %w", err)
	}
	registeredIDs, err := coordinator.GetRegisteredOracleIds(callOpts)
	if err != nil {
		return fmt.Errorf("getRegisteredOracleIds probe failed: %w", err)
	}
	seenActiveKeys := make(map[[32]byte]uint8, len(registeredIDs))
	for _, oracleID := range registeredIDs {
		registration, err := coordinator.GetOracle(callOpts, oracleID)
		if err != nil {
			return fmt.Errorf("getOracle(%d) probe failed: %w", oracleID, err)
		}
		if !registration.Active {
			continue
		}
		if strings.TrimSpace(registration.Did) == "" {
			return fmt.Errorf("oracle %d has empty DID", oracleID)
		}
		if registration.OraclesEncryptionKey == ([32]byte{}) {
			return fmt.Errorf("oracle %d has zero request-encryption key", oracleID)
		}
		if prevOracleID, exists := seenActiveKeys[registration.OraclesEncryptionKey]; exists {
			return fmt.Errorf(
				"oracle %d reuses request-encryption key from oracle %d",
				oracleID,
				prevOracleID,
			)
		}
		seenActiveKeys[registration.OraclesEncryptionKey] = oracleID
	}
	return nil
}

func ensureBootstrapContractDeployment(ctx context.Context, req bootstrapContractDeploymentRequest) (contractDeployment, bool, error) {
	providedAddress := strings.TrimSpace(req.ContractAddress)
	if providedAddress != "" {
		if err := validateCoordinatorDeployment(ctx, req.ContractRPCURL, providedAddress, req.OracleCount); err != nil {
			return contractDeployment{}, false, fmt.Errorf("validate provided coordinator %s: %w", providedAddress, err)
		}
		deployment := contractDeployment{
			ContractAddress: req.ContractAddress,
			OracleCount:     req.OracleCount,
			Source:          "provided",
		}
		if err := writeContractDeployment(req.RegistryDir, deployment); err != nil {
			return contractDeployment{}, false, err
		}
		deployment.ContractAddress = common.HexToAddress(providedAddress).Hex()
		return deployment, false, nil
	}

	if deployment, ok, err := tryReadContractDeployment(req.RegistryDir); err != nil {
		return contractDeployment{}, false, err
	} else if ok {
		if deployment.OracleCount > 0 && req.OracleCount > 0 && deployment.OracleCount != req.OracleCount {
			ok = false
		}
		if ok {
			err = validateCoordinatorDeployment(ctx, req.ContractRPCURL, deployment.ContractAddress, req.OracleCount)
		}
		if ok && err != nil {
			if strings.TrimSpace(req.ContractRPCURL) == "" {
				return contractDeployment{}, false, fmt.Errorf("validate cached coordinator %s: %w", deployment.ContractAddress, err)
			}
		} else if ok {
			if strings.TrimSpace(deployment.RequestRegistryAddress) == "" && strings.TrimSpace(req.ContractRPCURL) != "" {
				requestRegistryAddress, txHash, deployer, deployErr := noncentralizedclient.DeployRequestRegistry(ctx, noncentralizedclient.Config{
					RPCURL:   strings.TrimSpace(req.ContractRPCURL),
					CAVSURL:  strings.TrimSpace(req.CAVSURL),
					OracleID: req.Deployer.OracleID,
					DID:      strings.TrimSpace(req.Deployer.DID),
				})
				if deployErr != nil {
					return contractDeployment{}, false, deployErr
				}
				deployment.RequestRegistryAddress = requestRegistryAddress
				if strings.TrimSpace(deployment.TransactionHash) == "" {
					deployment.TransactionHash = txHash
				}
				if strings.TrimSpace(deployment.RequestRegistryTxHash) == "" {
					deployment.RequestRegistryTxHash = txHash
				}
				if strings.TrimSpace(deployment.Deployer) == "" {
					deployment.Deployer = deployer
				}
				if strings.TrimSpace(deployment.Source) == "" {
					deployment.Source = "bootstrap"
				}
				if err := writeContractDeployment(req.RegistryDir, deployment); err != nil {
					return contractDeployment{}, false, err
				}
			}
			return deployment, false, nil
		}
	}

	if strings.TrimSpace(req.ContractRPCURL) == "" {
		return contractDeployment{}, false, nil
	}
	if req.OracleCount <= 0 || req.OracleCount > 255 {
		return contractDeployment{}, false, fmt.Errorf("oracle count must fit uint8 (1..255), got %d", req.OracleCount)
	}
	if strings.TrimSpace(req.CAVSURL) == "" {
		return contractDeployment{}, false, fmt.Errorf("skill_extractor_url is required to auto-deploy the OCR coordinator")
	}
	if req.Deployer.OracleID < 0 {
		return contractDeployment{}, false, fmt.Errorf("bootstrap deployment requires a DID registry entry for oracle 0")
	}
	if strings.TrimSpace(req.Deployer.DID) == "" {
		return contractDeployment{}, false, fmt.Errorf("bootstrap deployment requires oracle 0 DID")
	}

	result, err := noncentralizedclient.DeployCoordinator(ctx, noncentralizedclient.Config{
		RPCURL:   strings.TrimSpace(req.ContractRPCURL),
		CAVSURL:  strings.TrimSpace(req.CAVSURL),
		OracleID: req.Deployer.OracleID,
		DID:      strings.TrimSpace(req.Deployer.DID),
	}, req.OracleCount)
	if err != nil {
		return contractDeployment{}, false, err
	}

	deployment := contractDeployment{
		ContractAddress:        result.ContractAddress,
		RequestRegistryAddress: result.RequestRegistryAddress,
		TransactionHash:        result.TransactionHash,
		CoordinatorTxHash:      result.CoordinatorTxHash,
		RequestRegistryTxHash:  result.RequestRegistryTxHash,
		OracleCount:            result.OracleCount,
		Deployer:               result.Deployer,
		Source:                 "bootstrap",
	}
	if err := writeContractDeployment(req.RegistryDir, deployment); err != nil {
		return contractDeployment{}, false, err
	}
	return deployment, true, nil
}
