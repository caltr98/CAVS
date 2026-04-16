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

	contractbindings "cavs/cavsonocr/Oracle/noncentralized/client/contracts"

	"github.com/ethereum/go-ethereum/accounts/abi/bind"
	"github.com/ethereum/go-ethereum/common"
	gethtypes "github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/ethclient"
)

type Client struct {
	eth      *ethclient.Client
	contract *contractbindings.CAVSOracleCoordinator
	cavsURL  string
	oracleID int
	did      string
	endpoint string
	from     common.Address
	chainID  *big.Int
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
	if strings.TrimSpace(cfg.Endpoint) == "" {
		return nil, fmt.Errorf("missing Endpoint")
	}
	if cfg.OracleID < 0 || cfg.OracleID > 255 {
		return nil, fmt.Errorf("OracleID must fit uint8 (0..255)")
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

	fromHex, err := resolveDIDEthAddressViaCAVS(nil, cfg.CAVSURL, cfg.DID)
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
		eth:      eth,
		contract: contract,
		cavsURL:  strings.TrimRight(cfg.CAVSURL, "/"),
		oracleID: cfg.OracleID,
		did:      strings.TrimSpace(cfg.DID),
		endpoint: strings.TrimSpace(cfg.Endpoint),
		from:     common.HexToAddress(fromHex),
		chainID:  chainID,
	}, nil
}

func (c *Client) Close() error {
	if c.eth != nil {
		c.eth.Close()
	}
	return nil
}

func (c *Client) RegisterOracle(ctx context.Context) error {
	tx, err := c.contract.RegisterOracle(c.newAuth(ctx), uint8(c.oracleID), c.did, c.endpoint)
	if err != nil {
		return fmt.Errorf("register oracle: %w", err)
	}
	return waitSuccessfulTx(ctx, c.eth, tx, "registerOracle")
}

func (c *Client) GetOracle(ctx context.Context, oracleID int) (*OracleRegistration, error) {
	if oracleID < 0 || oracleID > 255 {
		return nil, fmt.Errorf("oracleID must fit uint8 (0..255)")
	}
	reg, err := c.contract.GetOracle(&bind.CallOpts{Context: ctx}, uint8(oracleID))
	if err != nil {
		return nil, fmt.Errorf("get oracle %d: %w", oracleID, err)
	}
	if reg.Account == (common.Address{}) && strings.TrimSpace(reg.Endpoint) == "" && strings.TrimSpace(reg.Did) == "" {
		return nil, nil
	}
	return &OracleRegistration{
		OracleID:  int(reg.OracleId),
		Account:   reg.Account.Hex(),
		DID:       reg.Did,
		Endpoint:  reg.Endpoint,
		Active:    reg.Active,
		UpdatedAt: reg.UpdatedAt,
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
	auth := &bind.TransactOpts{
		From:    c.from,
		Context: ctx,
		Signer: func(address common.Address, tx *gethtypes.Transaction) (*gethtypes.Transaction, error) {
			if address != c.from {
				return nil, fmt.Errorf("unexpected signer address %s", address.Hex())
			}
			signer := gethtypes.LatestSignerForChainID(c.chainID)
			digest := signer.Hash(tx)
			sig, err := signDigestViaCAVS(ctx, c.cavsURL, c.oracleID, digest.Hex())
			if err != nil {
				return nil, err
			}
			return tx.WithSignature(signer, sig)
		},
	}

	if header, err := c.eth.HeaderByNumber(ctx, nil); err == nil && header != nil && header.BaseFee != nil {
		if tip, tipErr := c.eth.SuggestGasTipCap(ctx); tipErr == nil {
			auth.GasTipCap = tip
			auth.GasFeeCap = new(big.Int).Add(new(big.Int).Mul(header.BaseFee, big.NewInt(2)), tip)
		}
	} else if gasPrice, gasErr := c.eth.SuggestGasPrice(ctx); gasErr == nil {
		auth.GasPrice = gasPrice
	}

	return auth
}

func waitSuccessfulTx(ctx context.Context, eth *ethclient.Client, tx *gethtypes.Transaction, action string) error {
	receipt, err := bind.WaitMined(ctx, eth, tx)
	if err != nil {
		return fmt.Errorf("%s wait mined: %w", action, err)
	}
	if receipt == nil {
		return fmt.Errorf("%s missing receipt", action)
	}
	if receipt.Status != gethtypes.ReceiptStatusSuccessful {
		return fmt.Errorf("%s reverted with status=%d", action, receipt.Status)
	}
	return nil
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
	if len(sig) != 65 {
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
