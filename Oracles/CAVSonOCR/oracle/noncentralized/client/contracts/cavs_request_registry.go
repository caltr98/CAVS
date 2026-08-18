// Code generated - DO NOT EDIT.
// This file is a generated binding and any manual changes will be lost.

package contracts

import (
	"errors"
	"math/big"
	"strings"

	ethereum "github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/accounts/abi/bind"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/event"
)

// Reference imports to suppress errors if they are not otherwise used.
var (
	_ = errors.New
	_ = big.NewInt
	_ = strings.NewReader
	_ = ethereum.NotFound
	_ = bind.Bind
	_ = common.Big1
	_ = types.BloomLookup
	_ = event.NewSubscription
	_ = abi.ConvertType
)

// CAVSRequestRegistryKeyEnvelope is an auto generated low-level Go binding around an user-defined struct.
type CAVSRequestRegistryKeyEnvelope struct {
	OracleId           uint8
	EphemeralPublicKey [32]byte
	Nonce              [12]byte
	WrappedARequestKey []byte
}

// CAVSRequestRegistryMetaData contains all meta data concerning the CAVSRequestRegistry contract.
var CAVSRequestRegistryMetaData = &bind.MetaData{
	ABI: "[{\"inputs\":[],\"name\":\"DuplicateRequestID\",\"type\":\"error\"},{\"inputs\":[],\"name\":\"MissingBlobHash\",\"type\":\"error\"},{\"inputs\":[],\"name\":\"MissingKeyEnvelopes\",\"type\":\"error\"},{\"anonymous\":false,\"inputs\":[{\"indexed\":true,\"internalType\":\"bytes32\",\"name\":\"requestID\",\"type\":\"bytes32\"},{\"indexed\":true,\"internalType\":\"bytes32\",\"name\":\"oracleSetID\",\"type\":\"bytes32\"},{\"indexed\":true,\"internalType\":\"address\",\"name\":\"requester\",\"type\":\"address\"},{\"indexed\":false,\"internalType\":\"uint64\",\"name\":\"nonce\",\"type\":\"uint64\"},{\"indexed\":false,\"internalType\":\"uint64\",\"name\":\"deadline\",\"type\":\"uint64\"},{\"indexed\":false,\"internalType\":\"bytes32\",\"name\":\"blobHash\",\"type\":\"bytes32\"},{\"components\":[{\"internalType\":\"uint8\",\"name\":\"oracleId\",\"type\":\"uint8\"},{\"internalType\":\"bytes32\",\"name\":\"ephemeralPublicKey\",\"type\":\"bytes32\"},{\"internalType\":\"bytes12\",\"name\":\"nonce\",\"type\":\"bytes12\"},{\"internalType\":\"bytes\",\"name\":\"wrappedARequestKey\",\"type\":\"bytes\"}],\"indexed\":false,\"internalType\":\"structCAVSRequestRegistry.KeyEnvelope[]\",\"name\":\"keyEnvelopes\",\"type\":\"tuple[]\"}],\"name\":\"CAVSRequestSubmitted\",\"type\":\"event\"},{\"inputs\":[{\"internalType\":\"bytes32\",\"name\":\"requestID\",\"type\":\"bytes32\"},{\"internalType\":\"bytes32\",\"name\":\"oracleSetID\",\"type\":\"bytes32\"},{\"internalType\":\"uint64\",\"name\":\"nonce\",\"type\":\"uint64\"},{\"internalType\":\"uint64\",\"name\":\"deadline\",\"type\":\"uint64\"},{\"components\":[{\"internalType\":\"uint8\",\"name\":\"oracleId\",\"type\":\"uint8\"},{\"internalType\":\"bytes32\",\"name\":\"ephemeralPublicKey\",\"type\":\"bytes32\"},{\"internalType\":\"bytes12\",\"name\":\"nonce\",\"type\":\"bytes12\"},{\"internalType\":\"bytes\",\"name\":\"wrappedARequestKey\",\"type\":\"bytes\"}],\"internalType\":\"structCAVSRequestRegistry.KeyEnvelope[]\",\"name\":\"keyEnvelopes\",\"type\":\"tuple[]\"}],\"name\":\"submitBlobRequest\",\"outputs\":[],\"stateMutability\":\"nonpayable\",\"type\":\"function\"}]",
	Bin: "0x6080604052348015600e575f5ffd5b5061037c8061001c5f395ff3fe608060405234801561000f575f5ffd5b5060043610610029575f3560e01c8063030e3f9d1461002d575b5f5ffd5b61004061003b36600461014d565b610042565b005b5f498061006257604051639424524160e01b815260040160405180910390fd5b6100718787878785888861007a565b50505050505050565b5f8781526020819052604090205460ff16156100a95760405163ed7e2b5960e01b815260040160405180910390fd5b5f8190036100ca5760405163727b4ff560e01b815260040160405180910390fd5b5f8781526020819052604090819020805460ff19166001179055513390879089907f372d61c6f526e9f841740b1ee9bfee51dc82039e00414cb7d830bb91a6c3581690610120908a908a908a908a908a90610219565b60405180910390a450505050505050565b803567ffffffffffffffff81168114610148575f5ffd5b919050565b5f5f5f5f5f5f60a08789031215610162575f5ffd5b863595506020870135945061017960408801610131565b935061018760608801610131565b9250608087013567ffffffffffffffff8111156101a2575f5ffd5b8701601f810189136101b2575f5ffd5b803567ffffffffffffffff8111156101c8575f5ffd5b8960208260051b84010111156101dc575f5ffd5b60208201935080925050509295509295509295565b81835281816020850137505f828201602090810191909152601f909101601f19169091010190565b5f6080820167ffffffffffffffff8816835267ffffffffffffffff87166020840152856040840152608060608401528084825260a08401905060a08560051b8501019150855f607e19883603015b8782101561033657868503609f190184528235818112610285575f5ffd5b8901803560ff8116808214610298575f5ffd5b8752506020818101359087015260408101356001600160a01b031981168082146102c0575f5ffd5b604088015250606081013536829003601e190181126102dd575f5ffd5b0160208101903567ffffffffffffffff8111156102f8575f5ffd5b803603821315610306575f5ffd5b6080606088015261031b6080880182846101f1565b96505050602083019250602084019350600182019150610267565b50929a995050505050505050505056fea2646970667358221220c186032e93a51cefc119830d4393ac5152e0372f99a44d8d1079419a8121795764736f6c634300081c0033",
}

// CAVSRequestRegistryABI is the input ABI used to generate the binding from.
// Deprecated: Use CAVSRequestRegistryMetaData.ABI instead.
var CAVSRequestRegistryABI = CAVSRequestRegistryMetaData.ABI

// CAVSRequestRegistryBin is the compiled bytecode used for deploying new contracts.
// Deprecated: Use CAVSRequestRegistryMetaData.Bin instead.
var CAVSRequestRegistryBin = CAVSRequestRegistryMetaData.Bin

// DeployCAVSRequestRegistry deploys a new Ethereum contract, binding an instance of CAVSRequestRegistry to it.
func DeployCAVSRequestRegistry(auth *bind.TransactOpts, backend bind.ContractBackend) (common.Address, *types.Transaction, *CAVSRequestRegistry, error) {
	parsed, err := CAVSRequestRegistryMetaData.GetAbi()
	if err != nil {
		return common.Address{}, nil, nil, err
	}
	if parsed == nil {
		return common.Address{}, nil, nil, errors.New("GetABI returned nil")
	}

	address, tx, contract, err := bind.DeployContract(auth, *parsed, common.FromHex(CAVSRequestRegistryBin), backend)
	if err != nil {
		return common.Address{}, nil, nil, err
	}
	return address, tx, &CAVSRequestRegistry{CAVSRequestRegistryCaller: CAVSRequestRegistryCaller{contract: contract}, CAVSRequestRegistryTransactor: CAVSRequestRegistryTransactor{contract: contract}, CAVSRequestRegistryFilterer: CAVSRequestRegistryFilterer{contract: contract}}, nil
}

// CAVSRequestRegistry is an auto generated Go binding around an Ethereum contract.
type CAVSRequestRegistry struct {
	CAVSRequestRegistryCaller     // Read-only binding to the contract
	CAVSRequestRegistryTransactor // Write-only binding to the contract
	CAVSRequestRegistryFilterer   // Log filterer for contract events
}

// CAVSRequestRegistryCaller is an auto generated read-only Go binding around an Ethereum contract.
type CAVSRequestRegistryCaller struct {
	contract *bind.BoundContract // Generic contract wrapper for the low level calls
}

// CAVSRequestRegistryTransactor is an auto generated write-only Go binding around an Ethereum contract.
type CAVSRequestRegistryTransactor struct {
	contract *bind.BoundContract // Generic contract wrapper for the low level calls
}

// CAVSRequestRegistryFilterer is an auto generated log filtering Go binding around an Ethereum contract events.
type CAVSRequestRegistryFilterer struct {
	contract *bind.BoundContract // Generic contract wrapper for the low level calls
}

// CAVSRequestRegistrySession is an auto generated Go binding around an Ethereum contract,
// with pre-set call and transact options.
type CAVSRequestRegistrySession struct {
	Contract     *CAVSRequestRegistry // Generic contract binding to set the session for
	CallOpts     bind.CallOpts        // Call options to use throughout this session
	TransactOpts bind.TransactOpts    // Transaction auth options to use throughout this session
}

// CAVSRequestRegistryCallerSession is an auto generated read-only Go binding around an Ethereum contract,
// with pre-set call options.
type CAVSRequestRegistryCallerSession struct {
	Contract *CAVSRequestRegistryCaller // Generic contract caller binding to set the session for
	CallOpts bind.CallOpts              // Call options to use throughout this session
}

// CAVSRequestRegistryTransactorSession is an auto generated write-only Go binding around an Ethereum contract,
// with pre-set transact options.
type CAVSRequestRegistryTransactorSession struct {
	Contract     *CAVSRequestRegistryTransactor // Generic contract transactor binding to set the session for
	TransactOpts bind.TransactOpts              // Transaction auth options to use throughout this session
}

// CAVSRequestRegistryRaw is an auto generated low-level Go binding around an Ethereum contract.
type CAVSRequestRegistryRaw struct {
	Contract *CAVSRequestRegistry // Generic contract binding to access the raw methods on
}

// CAVSRequestRegistryCallerRaw is an auto generated low-level read-only Go binding around an Ethereum contract.
type CAVSRequestRegistryCallerRaw struct {
	Contract *CAVSRequestRegistryCaller // Generic read-only contract binding to access the raw methods on
}

// CAVSRequestRegistryTransactorRaw is an auto generated low-level write-only Go binding around an Ethereum contract.
type CAVSRequestRegistryTransactorRaw struct {
	Contract *CAVSRequestRegistryTransactor // Generic write-only contract binding to access the raw methods on
}

// NewCAVSRequestRegistry creates a new instance of CAVSRequestRegistry, bound to a specific deployed contract.
func NewCAVSRequestRegistry(address common.Address, backend bind.ContractBackend) (*CAVSRequestRegistry, error) {
	contract, err := bindCAVSRequestRegistry(address, backend, backend, backend)
	if err != nil {
		return nil, err
	}
	return &CAVSRequestRegistry{CAVSRequestRegistryCaller: CAVSRequestRegistryCaller{contract: contract}, CAVSRequestRegistryTransactor: CAVSRequestRegistryTransactor{contract: contract}, CAVSRequestRegistryFilterer: CAVSRequestRegistryFilterer{contract: contract}}, nil
}

// NewCAVSRequestRegistryCaller creates a new read-only instance of CAVSRequestRegistry, bound to a specific deployed contract.
func NewCAVSRequestRegistryCaller(address common.Address, caller bind.ContractCaller) (*CAVSRequestRegistryCaller, error) {
	contract, err := bindCAVSRequestRegistry(address, caller, nil, nil)
	if err != nil {
		return nil, err
	}
	return &CAVSRequestRegistryCaller{contract: contract}, nil
}

// NewCAVSRequestRegistryTransactor creates a new write-only instance of CAVSRequestRegistry, bound to a specific deployed contract.
func NewCAVSRequestRegistryTransactor(address common.Address, transactor bind.ContractTransactor) (*CAVSRequestRegistryTransactor, error) {
	contract, err := bindCAVSRequestRegistry(address, nil, transactor, nil)
	if err != nil {
		return nil, err
	}
	return &CAVSRequestRegistryTransactor{contract: contract}, nil
}

// NewCAVSRequestRegistryFilterer creates a new log filterer instance of CAVSRequestRegistry, bound to a specific deployed contract.
func NewCAVSRequestRegistryFilterer(address common.Address, filterer bind.ContractFilterer) (*CAVSRequestRegistryFilterer, error) {
	contract, err := bindCAVSRequestRegistry(address, nil, nil, filterer)
	if err != nil {
		return nil, err
	}
	return &CAVSRequestRegistryFilterer{contract: contract}, nil
}

// bindCAVSRequestRegistry binds a generic wrapper to an already deployed contract.
func bindCAVSRequestRegistry(address common.Address, caller bind.ContractCaller, transactor bind.ContractTransactor, filterer bind.ContractFilterer) (*bind.BoundContract, error) {
	parsed, err := CAVSRequestRegistryMetaData.GetAbi()
	if err != nil {
		return nil, err
	}
	return bind.NewBoundContract(address, *parsed, caller, transactor, filterer), nil
}

// Call invokes the (constant) contract method with params as input values and
// sets the output to result. The result type might be a single field for simple
// returns, a slice of interfaces for anonymous returns and a struct for named
// returns.
func (_CAVSRequestRegistry *CAVSRequestRegistryRaw) Call(opts *bind.CallOpts, result *[]interface{}, method string, params ...interface{}) error {
	return _CAVSRequestRegistry.Contract.CAVSRequestRegistryCaller.contract.Call(opts, result, method, params...)
}

// Transfer initiates a plain transaction to move funds to the contract, calling
// its default method if one is available.
func (_CAVSRequestRegistry *CAVSRequestRegistryRaw) Transfer(opts *bind.TransactOpts) (*types.Transaction, error) {
	return _CAVSRequestRegistry.Contract.CAVSRequestRegistryTransactor.contract.Transfer(opts)
}

// Transact invokes the (paid) contract method with params as input values.
func (_CAVSRequestRegistry *CAVSRequestRegistryRaw) Transact(opts *bind.TransactOpts, method string, params ...interface{}) (*types.Transaction, error) {
	return _CAVSRequestRegistry.Contract.CAVSRequestRegistryTransactor.contract.Transact(opts, method, params...)
}

// Call invokes the (constant) contract method with params as input values and
// sets the output to result. The result type might be a single field for simple
// returns, a slice of interfaces for anonymous returns and a struct for named
// returns.
func (_CAVSRequestRegistry *CAVSRequestRegistryCallerRaw) Call(opts *bind.CallOpts, result *[]interface{}, method string, params ...interface{}) error {
	return _CAVSRequestRegistry.Contract.contract.Call(opts, result, method, params...)
}

// Transfer initiates a plain transaction to move funds to the contract, calling
// its default method if one is available.
func (_CAVSRequestRegistry *CAVSRequestRegistryTransactorRaw) Transfer(opts *bind.TransactOpts) (*types.Transaction, error) {
	return _CAVSRequestRegistry.Contract.contract.Transfer(opts)
}

// Transact invokes the (paid) contract method with params as input values.
func (_CAVSRequestRegistry *CAVSRequestRegistryTransactorRaw) Transact(opts *bind.TransactOpts, method string, params ...interface{}) (*types.Transaction, error) {
	return _CAVSRequestRegistry.Contract.contract.Transact(opts, method, params...)
}

// SubmitBlobRequest is a paid mutator transaction binding the contract method 0x030e3f9d.
//
// Solidity: function submitBlobRequest(bytes32 requestID, bytes32 oracleSetID, uint64 nonce, uint64 deadline, (uint8,bytes32,bytes12,bytes)[] keyEnvelopes) returns()
func (_CAVSRequestRegistry *CAVSRequestRegistryTransactor) SubmitBlobRequest(opts *bind.TransactOpts, requestID [32]byte, oracleSetID [32]byte, nonce uint64, deadline uint64, keyEnvelopes []CAVSRequestRegistryKeyEnvelope) (*types.Transaction, error) {
	return _CAVSRequestRegistry.contract.Transact(opts, "submitBlobRequest", requestID, oracleSetID, nonce, deadline, keyEnvelopes)
}

// SubmitBlobRequest is a paid mutator transaction binding the contract method 0x030e3f9d.
//
// Solidity: function submitBlobRequest(bytes32 requestID, bytes32 oracleSetID, uint64 nonce, uint64 deadline, (uint8,bytes32,bytes12,bytes)[] keyEnvelopes) returns()
func (_CAVSRequestRegistry *CAVSRequestRegistrySession) SubmitBlobRequest(requestID [32]byte, oracleSetID [32]byte, nonce uint64, deadline uint64, keyEnvelopes []CAVSRequestRegistryKeyEnvelope) (*types.Transaction, error) {
	return _CAVSRequestRegistry.Contract.SubmitBlobRequest(&_CAVSRequestRegistry.TransactOpts, requestID, oracleSetID, nonce, deadline, keyEnvelopes)
}

// SubmitBlobRequest is a paid mutator transaction binding the contract method 0x030e3f9d.
//
// Solidity: function submitBlobRequest(bytes32 requestID, bytes32 oracleSetID, uint64 nonce, uint64 deadline, (uint8,bytes32,bytes12,bytes)[] keyEnvelopes) returns()
func (_CAVSRequestRegistry *CAVSRequestRegistryTransactorSession) SubmitBlobRequest(requestID [32]byte, oracleSetID [32]byte, nonce uint64, deadline uint64, keyEnvelopes []CAVSRequestRegistryKeyEnvelope) (*types.Transaction, error) {
	return _CAVSRequestRegistry.Contract.SubmitBlobRequest(&_CAVSRequestRegistry.TransactOpts, requestID, oracleSetID, nonce, deadline, keyEnvelopes)
}

// CAVSRequestRegistryCAVSRequestSubmittedIterator is returned from FilterCAVSRequestSubmitted and is used to iterate over the raw logs and unpacked data for CAVSRequestSubmitted events raised by the CAVSRequestRegistry contract.
type CAVSRequestRegistryCAVSRequestSubmittedIterator struct {
	Event *CAVSRequestRegistryCAVSRequestSubmitted // Event containing the contract specifics and raw log

	contract *bind.BoundContract // Generic contract to use for unpacking event data
	event    string              // Event name to use for unpacking event data

	logs chan types.Log        // Log channel receiving the found contract events
	sub  ethereum.Subscription // Subscription for errors, completion and termination
	done bool                  // Whether the subscription completed delivering logs
	fail error                 // Occurred error to stop iteration
}

// Next advances the iterator to the subsequent event, returning whether there
// are any more events found. In case of a retrieval or parsing error, false is
// returned and Error() can be queried for the exact failure.
func (it *CAVSRequestRegistryCAVSRequestSubmittedIterator) Next() bool {
	// If the iterator failed, stop iterating
	if it.fail != nil {
		return false
	}
	// If the iterator completed, deliver directly whatever's available
	if it.done {
		select {
		case log := <-it.logs:
			it.Event = new(CAVSRequestRegistryCAVSRequestSubmitted)
			if err := it.contract.UnpackLog(it.Event, it.event, log); err != nil {
				it.fail = err
				return false
			}
			it.Event.Raw = log
			return true

		default:
			return false
		}
	}
	// Iterator still in progress, wait for either a data or an error event
	select {
	case log := <-it.logs:
		it.Event = new(CAVSRequestRegistryCAVSRequestSubmitted)
		if err := it.contract.UnpackLog(it.Event, it.event, log); err != nil {
			it.fail = err
			return false
		}
		it.Event.Raw = log
		return true

	case err := <-it.sub.Err():
		it.done = true
		it.fail = err
		return it.Next()
	}
}

// Error returns any retrieval or parsing error occurred during filtering.
func (it *CAVSRequestRegistryCAVSRequestSubmittedIterator) Error() error {
	return it.fail
}

// Close terminates the iteration process, releasing any pending underlying
// resources.
func (it *CAVSRequestRegistryCAVSRequestSubmittedIterator) Close() error {
	it.sub.Unsubscribe()
	return nil
}

// CAVSRequestRegistryCAVSRequestSubmitted represents a CAVSRequestSubmitted event raised by the CAVSRequestRegistry contract.
type CAVSRequestRegistryCAVSRequestSubmitted struct {
	RequestID    [32]byte
	OracleSetID  [32]byte
	Requester    common.Address
	Nonce        uint64
	Deadline     uint64
	BlobHash     [32]byte
	KeyEnvelopes []CAVSRequestRegistryKeyEnvelope
	Raw          types.Log // Blockchain specific contextual infos
}

// FilterCAVSRequestSubmitted is a free log retrieval operation binding the contract event 0x372d61c6f526e9f841740b1ee9bfee51dc82039e00414cb7d830bb91a6c35816.
//
// Solidity: event CAVSRequestSubmitted(bytes32 indexed requestID, bytes32 indexed oracleSetID, address indexed requester, uint64 nonce, uint64 deadline, bytes32 blobHash, (uint8,bytes32,bytes12,bytes)[] keyEnvelopes)
func (_CAVSRequestRegistry *CAVSRequestRegistryFilterer) FilterCAVSRequestSubmitted(opts *bind.FilterOpts, requestID [][32]byte, oracleSetID [][32]byte, requester []common.Address) (*CAVSRequestRegistryCAVSRequestSubmittedIterator, error) {

	var requestIDRule []interface{}
	for _, requestIDItem := range requestID {
		requestIDRule = append(requestIDRule, requestIDItem)
	}
	var oracleSetIDRule []interface{}
	for _, oracleSetIDItem := range oracleSetID {
		oracleSetIDRule = append(oracleSetIDRule, oracleSetIDItem)
	}
	var requesterRule []interface{}
	for _, requesterItem := range requester {
		requesterRule = append(requesterRule, requesterItem)
	}

	logs, sub, err := _CAVSRequestRegistry.contract.FilterLogs(opts, "CAVSRequestSubmitted", requestIDRule, oracleSetIDRule, requesterRule)
	if err != nil {
		return nil, err
	}
	return &CAVSRequestRegistryCAVSRequestSubmittedIterator{contract: _CAVSRequestRegistry.contract, event: "CAVSRequestSubmitted", logs: logs, sub: sub}, nil
}

// WatchCAVSRequestSubmitted is a free log subscription operation binding the contract event 0x372d61c6f526e9f841740b1ee9bfee51dc82039e00414cb7d830bb91a6c35816.
//
// Solidity: event CAVSRequestSubmitted(bytes32 indexed requestID, bytes32 indexed oracleSetID, address indexed requester, uint64 nonce, uint64 deadline, bytes32 blobHash, (uint8,bytes32,bytes12,bytes)[] keyEnvelopes)
func (_CAVSRequestRegistry *CAVSRequestRegistryFilterer) WatchCAVSRequestSubmitted(opts *bind.WatchOpts, sink chan<- *CAVSRequestRegistryCAVSRequestSubmitted, requestID [][32]byte, oracleSetID [][32]byte, requester []common.Address) (event.Subscription, error) {

	var requestIDRule []interface{}
	for _, requestIDItem := range requestID {
		requestIDRule = append(requestIDRule, requestIDItem)
	}
	var oracleSetIDRule []interface{}
	for _, oracleSetIDItem := range oracleSetID {
		oracleSetIDRule = append(oracleSetIDRule, oracleSetIDItem)
	}
	var requesterRule []interface{}
	for _, requesterItem := range requester {
		requesterRule = append(requesterRule, requesterItem)
	}

	logs, sub, err := _CAVSRequestRegistry.contract.WatchLogs(opts, "CAVSRequestSubmitted", requestIDRule, oracleSetIDRule, requesterRule)
	if err != nil {
		return nil, err
	}
	return event.NewSubscription(func(quit <-chan struct{}) error {
		defer sub.Unsubscribe()
		for {
			select {
			case log := <-logs:
				// New log arrived, parse the event and forward to the user
				event := new(CAVSRequestRegistryCAVSRequestSubmitted)
				if err := _CAVSRequestRegistry.contract.UnpackLog(event, "CAVSRequestSubmitted", log); err != nil {
					return err
				}
				event.Raw = log

				select {
				case sink <- event:
				case err := <-sub.Err():
					return err
				case <-quit:
					return nil
				}
			case err := <-sub.Err():
				return err
			case <-quit:
				return nil
			}
		}
	}), nil
}

// ParseCAVSRequestSubmitted is a log parse operation binding the contract event 0x372d61c6f526e9f841740b1ee9bfee51dc82039e00414cb7d830bb91a6c35816.
//
// Solidity: event CAVSRequestSubmitted(bytes32 indexed requestID, bytes32 indexed oracleSetID, address indexed requester, uint64 nonce, uint64 deadline, bytes32 blobHash, (uint8,bytes32,bytes12,bytes)[] keyEnvelopes)
func (_CAVSRequestRegistry *CAVSRequestRegistryFilterer) ParseCAVSRequestSubmitted(log types.Log) (*CAVSRequestRegistryCAVSRequestSubmitted, error) {
	event := new(CAVSRequestRegistryCAVSRequestSubmitted)
	if err := _CAVSRequestRegistry.contract.UnpackLog(event, "CAVSRequestSubmitted", log); err != nil {
		return nil, err
	}
	event.Raw = log
	return event, nil
}
