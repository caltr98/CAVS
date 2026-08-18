package client

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"strings"
	"time"

	contractbindings "cavs/cavsonocr/oracle/noncentralized/client/contracts"

	"github.com/ethereum/go-ethereum/accounts/abi/bind"
	"github.com/ethereum/go-ethereum/common"
	gethtypes "github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/ethclient"
)

type Client struct {
	eth                  *ethclient.Client
	contract             *contractbindings.CAVSOracleCoordinator
	cavsURL              string
	oracleID             int
	did                  string
	oraclesEncryptionKey [32]byte
	from                 common.Address
	chainID              *big.Int
}

func New(ctx context.Context, cfg Config) (*Client, error) {
	if strings.TrimSpace(cfg.RPCURL) == "" {
		return nil, fmt.Errorf("missing RPCURL")
	}
	if strings.TrimSpace(cfg.ContractAddress) == "" {
		return nil, fmt.Errorf("missing ContractAddress")
	}
	if strings.TrimSpace(cfg.CAVSURL) == "" {
		return nil, fmt.Errorf("missing CAVSURL")
	}
	if strings.TrimSpace(cfg.DID) == "" {
		return nil, fmt.Errorf("missing DID")
	}
	if cfg.OracleID < 0 || cfg.OracleID > 255 {
		return nil, fmt.Errorf("OracleID must fit uint8 (0..255)")
	}
	if cfg.OraclesEncryptionKey == ([32]byte{}) {
		return nil, fmt.Errorf("missing OraclesEncryptionKey")
	}

	eth, err := ethclient.DialContext(ctx, cfg.RPCURL)
	if err != nil {
		return nil, fmt.Errorf("dial eth client: %w", err)
	}

	contractAddress := common.HexToAddress(cfg.ContractAddress)
	contract, err := contractbindings.NewCAVSOracleCoordinator(contractAddress, eth)
	if err != nil {
		eth.Close()
		return nil, fmt.Errorf("bind contract: %w", err)
	}

	cavsURL := strings.TrimRight(strings.TrimSpace(cfg.CAVSURL), "/")
	fromHex, err := resolveDIDEthAddressViaCAVS(nil, cavsURL, cfg.DID)
	if err != nil {
		eth.Close()
		return nil, err
	}
	chainID, err := eth.ChainID(ctx)
	if err != nil {
		eth.Close()
		return nil, fmt.Errorf("resolve chain id: %w", err)
	}

	return &Client{
		eth:                  eth,
		contract:             contract,
		cavsURL:              cavsURL,
		oracleID:             cfg.OracleID,
		did:                  strings.TrimSpace(cfg.DID),
		oraclesEncryptionKey: cfg.OraclesEncryptionKey,
		from:                 common.HexToAddress(fromHex),
		chainID:              chainID,
	}, nil
}

func DeployCoordinator(ctx context.Context, cfg Config, oracleCount int) (*DeployResult, error) {
	if strings.TrimSpace(cfg.RPCURL) == "" {
		return nil, fmt.Errorf("missing RPCURL")
	}
	if strings.TrimSpace(cfg.CAVSURL) == "" {
		return nil, fmt.Errorf("missing CAVSURL")
	}
	if strings.TrimSpace(cfg.DID) == "" {
		return nil, fmt.Errorf("missing DID")
	}
	if cfg.OracleID < 0 || cfg.OracleID > 255 {
		return nil, fmt.Errorf("OracleID must fit uint8 (0..255)")
	}
	if oracleCount <= 0 || oracleCount > 255 {
		return nil, fmt.Errorf("oracleCount must fit uint8 (1..255)")
	}

	eth, err := ethclient.DialContext(ctx, cfg.RPCURL)
	if err != nil {
		return nil, fmt.Errorf("dial eth client: %w", err)
	}
	defer eth.Close()

	cavsURL := strings.TrimRight(strings.TrimSpace(cfg.CAVSURL), "/")
	fromHex, err := resolveDIDEthAddressViaCAVS(nil, cavsURL, cfg.DID)
	if err != nil {
		return nil, err
	}
	chainID, err := eth.ChainID(ctx)
	if err != nil {
		return nil, fmt.Errorf("resolve chain id: %w", err)
	}
	from := common.HexToAddress(fromHex)
	auth := newCAVSTransactOpts(ctx, eth, chainID, from, cavsURL, cfg.OracleID)

	address, tx, _, err := contractbindings.DeployCAVSOracleCoordinator(auth, eth, uint8(oracleCount))
	if err != nil {
		return nil, fmt.Errorf("deploy coordinator: %w", err)
	}
	if _, err := waitSuccessfulTxReceipt(ctx, eth, tx, "deploy CAVSOracleCoordinator"); err != nil {
		return nil, err
	}
	requestRegistryAddress, requestRegistryTx, _, err := contractbindings.DeployCAVSRequestRegistry(auth, eth)
	if err != nil {
		return nil, fmt.Errorf("deploy request registry: %w", err)
	}
	if _, err := waitSuccessfulTxReceipt(ctx, eth, requestRegistryTx, "deploy CAVSRequestRegistry"); err != nil {
		return nil, err
	}
	return &DeployResult{
		ContractAddress:        address.Hex(),
		RequestRegistryAddress: requestRegistryAddress.Hex(),
		TransactionHash:        tx.Hash().Hex(),
		CoordinatorTxHash:      tx.Hash().Hex(),
		RequestRegistryTxHash:  requestRegistryTx.Hash().Hex(),
		OracleCount:            oracleCount,
		Deployer:               from.Hex(),
	}, nil
}

func DeployRequestRegistry(ctx context.Context, cfg Config) (string, string, string, error) {
	if strings.TrimSpace(cfg.RPCURL) == "" {
		return "", "", "", fmt.Errorf("missing RPCURL")
	}
	if strings.TrimSpace(cfg.CAVSURL) == "" {
		return "", "", "", fmt.Errorf("missing CAVSURL")
	}
	if strings.TrimSpace(cfg.DID) == "" {
		return "", "", "", fmt.Errorf("missing DID")
	}
	if cfg.OracleID < 0 || cfg.OracleID > 255 {
		return "", "", "", fmt.Errorf("OracleID must fit uint8 (0..255)")
	}

	eth, err := ethclient.DialContext(ctx, cfg.RPCURL)
	if err != nil {
		return "", "", "", fmt.Errorf("dial eth client: %w", err)
	}
	defer eth.Close()

	cavsURL := strings.TrimRight(strings.TrimSpace(cfg.CAVSURL), "/")
	fromHex, err := resolveDIDEthAddressViaCAVS(nil, cavsURL, cfg.DID)
	if err != nil {
		return "", "", "", err
	}
	chainID, err := eth.ChainID(ctx)
	if err != nil {
		return "", "", "", fmt.Errorf("resolve chain id: %w", err)
	}
	from := common.HexToAddress(fromHex)
	auth := newCAVSTransactOpts(ctx, eth, chainID, from, cavsURL, cfg.OracleID)

	requestRegistryAddress, requestRegistryTx, _, err := contractbindings.DeployCAVSRequestRegistry(auth, eth)
	if err != nil {
		return "", "", "", fmt.Errorf("deploy request registry: %w", err)
	}
	if _, err := waitSuccessfulTxReceipt(ctx, eth, requestRegistryTx, "deploy CAVSRequestRegistry"); err != nil {
		return "", "", "", err
	}
	return requestRegistryAddress.Hex(), requestRegistryTx.Hash().Hex(), from.Hex(), nil
}

func (c *Client) Close() error {
	if c.eth != nil {
		c.eth.Close()
	}
	return nil
}

func (c *Client) RegisterOracle(ctx context.Context) (*RegisterResult, error) {
	expectedOEncryKey := "0x" + hex.EncodeToString(c.oraclesEncryptionKey[:])

	for attempt := 1; attempt <= 5; attempt++ {
		existing, err := c.GetOracle(ctx, c.oracleID)
		if err != nil {
			return nil, err
		}
		if existing != nil &&
			existing.Active &&
			strings.EqualFold(existing.Account, c.from.Hex()) &&
			strings.TrimSpace(existing.DID) == c.did &&
			strings.EqualFold(strings.TrimSpace(existing.OraclesEncryptionKey), expectedOEncryKey) {
			return &RegisterResult{
				OracleID: c.oracleID,
				Account:  c.from.Hex(),
				DID:      c.did,
				Noop:     true,
			}, nil
		}

		tx, err := c.contract.RegisterOracle(c.newAuthWithPendingNonce(ctx), uint8(c.oracleID), c.did, c.oraclesEncryptionKey)
		if err != nil {
			if isNonceRetryableError(err) && attempt < 5 {
				time.Sleep(time.Duration(attempt) * time.Second)
				continue
			}
			return nil, fmt.Errorf("register oracle: %w", err)
		}
		if _, err := waitSuccessfulTxReceipt(ctx, c.eth, tx, "registerOracle"); err != nil {
			if isNonceRetryableError(err) && attempt < 5 {
				time.Sleep(time.Duration(attempt) * time.Second)
				continue
			}
			return nil, err
		}
		return &RegisterResult{
			OracleID:        c.oracleID,
			Account:         c.from.Hex(),
			DID:             c.did,
			TransactionHash: tx.Hash().Hex(),
		}, nil
	}

	return nil, fmt.Errorf("register oracle: exhausted nonce retry attempts")
}

func (c *Client) GetOracle(ctx context.Context, oracleID int) (*OracleRegistration, error) {
	if oracleID < 0 || oracleID > 255 {
		return nil, fmt.Errorf("oracleID must fit uint8 (0..255)")
	}
	reg, err := c.contract.GetOracle(&bind.CallOpts{Context: ctx}, uint8(oracleID))
	if err != nil {
		return nil, fmt.Errorf("get oracle %d: %w", oracleID, err)
	}
	if reg.Account == (common.Address{}) && strings.TrimSpace(reg.Did) == "" {
		return nil, nil
	}
	return &OracleRegistration{
		OracleID:             int(reg.OracleId),
		Account:              reg.Account.Hex(),
		DID:                  reg.Did,
		OraclesEncryptionKey: "0x" + hex.EncodeToString(reg.OraclesEncryptionKey[:]),
		Active:               reg.Active,
		UpdatedAt:            reg.UpdatedAt,
	}, nil
}

func (c *Client) ListOracles(ctx context.Context) ([]OracleRegistration, error) {
	rawIDs, err := c.contract.GetRegisteredOracleIds(&bind.CallOpts{Context: ctx})
	if err != nil {
		return nil, fmt.Errorf("get registered oracle ids: %w", err)
	}
	out := make([]OracleRegistration, 0, len(rawIDs))
	for _, rawID := range rawIDs {
		reg, err := c.GetOracle(ctx, int(rawID))
		if err != nil {
			return nil, err
		}
		if reg == nil {
			continue
		}
		out = append(out, *reg)
	}
	return out, nil
}

func (c *Client) newAuth(ctx context.Context) *bind.TransactOpts {
	return newCAVSTransactOpts(ctx, c.eth, c.chainID, c.from, c.cavsURL, c.oracleID)
}

func (c *Client) newAuthWithPendingNonce(ctx context.Context) *bind.TransactOpts {
	auth := c.newAuth(ctx)
	if nonce, err := c.eth.PendingNonceAt(ctx, c.from); err == nil {
		auth.Nonce = new(big.Int).SetUint64(nonce)
	}
	return auth
}

func newCAVSTransactOpts(ctx context.Context, eth *ethclient.Client, chainID *big.Int, from common.Address, cavsURL string, oracleID int) *bind.TransactOpts {
	auth := &bind.TransactOpts{
		From:    from,
		Context: ctx,
		Signer: func(address common.Address, tx *gethtypes.Transaction) (*gethtypes.Transaction, error) {
			if address != from {
				return nil, fmt.Errorf("unexpected signer address %s", address.Hex())
			}
			signer := gethtypes.LatestSignerForChainID(chainID)
			digest := signer.Hash(tx)
			sig, err := signDigestViaCAVS(ctx, cavsURL, oracleID, digest.Hex())
			if err != nil {
				return nil, err
			}
			return tx.WithSignature(signer, sig)
		},
	}

	if header, err := eth.HeaderByNumber(ctx, nil); err == nil && header != nil && header.BaseFee != nil {
		if tip, tipErr := eth.SuggestGasTipCap(ctx); tipErr == nil {
			auth.GasTipCap = tip
			auth.GasFeeCap = new(big.Int).Add(new(big.Int).Mul(header.BaseFee, big.NewInt(2)), tip)
		}
	} else if gasPrice, gasErr := eth.SuggestGasPrice(ctx); gasErr == nil {
		auth.GasPrice = gasPrice
	}

	return auth
}

func isNonceRetryableError(err error) bool {
	if err == nil {
		return false
	}
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "nonce too low") ||
		strings.Contains(msg, "already known") ||
		strings.Contains(msg, "replacement transaction underpriced") ||
		strings.Contains(msg, "replacement fee too low") ||
		strings.Contains(msg, "transaction underpriced")
}

func waitSuccessfulTx(ctx context.Context, eth *ethclient.Client, tx *gethtypes.Transaction, action string) error {
	_, err := waitSuccessfulTxReceipt(ctx, eth, tx, action)
	return err
}

func waitSuccessfulTxReceipt(ctx context.Context, eth *ethclient.Client, tx *gethtypes.Transaction, action string) (*gethtypes.Receipt, error) {
	receipt, err := bind.WaitMined(ctx, eth, tx)
	if err != nil {
		return nil, fmt.Errorf("%s wait mined: %w", action, err)
	}
	if receipt == nil {
		return nil, fmt.Errorf("%s missing receipt", action)
	}
	if receipt.Status != gethtypes.ReceiptStatusSuccessful {
		return nil, fmt.Errorf("%s reverted with status=%d", action, receipt.Status)
	}
	return receipt, nil
}

func signDigestViaCAVS(ctx context.Context, cavsURL string, oracleID int, digestHex string) ([]byte, error) {
	var resp struct {
		SignatureHex string `json:"signatureHex"`
	}
	if err := httpPostJSON(ctx, nil, cavsURL+"/message/sign", map[string]any{
		"oracleId":  oracleID,
		"digestHex": digestHex,
	}, &resp); err != nil {
		return nil, fmt.Errorf("sign digest via cavs: %w", err)
	}
	sig, err := hex.DecodeString(strings.TrimPrefix(strings.TrimSpace(resp.SignatureHex), "0x"))
	if err != nil {
		return nil, fmt.Errorf("decode cavs signature: %w", err)
	}
	switch len(sig) {
	case 64:
		expanded := make([]byte, 65)
		copy(expanded[:32], sig[:32])
		copy(expanded[32:64], sig[32:64])
		if expanded[32]&0x80 != 0 {
			expanded[64] = 1
			expanded[32] &= 0x7f
		}
		sig = expanded
	case 65:
		// Standard r||s||v form.
	default:
		return nil, fmt.Errorf("unexpected signature length %d", len(sig))
	}
	if sig[64] >= 27 {
		sig[64] -= 27
	}
	if sig[64] > 1 {
		return nil, fmt.Errorf("unexpected signature recovery id %d", sig[64])
	}
	return sig, nil
}

func resolveDIDEthAddressViaCAVS(client *http.Client, cavsURL string, did string) (string, error) {
	parts := strings.Split(strings.TrimSpace(did), ":")
	if len(parts) > 0 && common.IsHexAddress(parts[len(parts)-1]) {
		return common.HexToAddress(parts[len(parts)-1]).Hex(), nil
	}
	var resp struct {
		OK         bool   `json:"ok"`
		DID        string `json:"did"`
		EthAddress string `json:"eth_address"`
	}
	if err := httpPostJSON(context.Background(), client, strings.TrimRight(cavsURL, "/")+"/identity/resolve", map[string]any{
		"did": did,
	}, &resp); err != nil {
		return "", fmt.Errorf("resolve did via cavs %q: %w", did, err)
	}
	if !common.IsHexAddress(resp.EthAddress) {
		return "", fmt.Errorf("invalid cavs eth address %q for did %q", resp.EthAddress, did)
	}
	return common.HexToAddress(resp.EthAddress).Hex(), nil
}

func httpPostJSON(ctx context.Context, client *http.Client, url string, body any, out any) error {
	payload, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if client == nil {
		client = &http.Client{Timeout: 30 * time.Second}
	}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		bodyBytes, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("http %d: %s", resp.StatusCode, strings.TrimSpace(string(bodyBytes)))
	}
	if out == nil {
		return nil
	}
	return json.NewDecoder(resp.Body).Decode(out)
}
