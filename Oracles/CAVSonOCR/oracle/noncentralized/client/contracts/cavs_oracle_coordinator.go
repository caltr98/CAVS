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

// CAVSOracleCoordinatorOracleRegistration is an auto generated low-level Go binding around an user-defined struct.
type CAVSOracleCoordinatorOracleRegistration struct {
	OracleId             uint8
	Account              common.Address
	Did                  string
	OraclesEncryptionKey [32]byte
	Active               bool
	UpdatedAt            uint64
}

// CAVSOracleCoordinatorMetaData contains all meta data concerning the CAVSOracleCoordinator contract.
var CAVSOracleCoordinatorMetaData = &bind.MetaData{
	ABI: "[{\"inputs\":[{\"internalType\":\"uint8\",\"name\":\"oracleCount_\",\"type\":\"uint8\"}],\"stateMutability\":\"nonpayable\",\"type\":\"constructor\"},{\"inputs\":[],\"name\":\"AccountAlreadyRegistered\",\"type\":\"error\"},{\"inputs\":[],\"name\":\"AccountNotRegistered\",\"type\":\"error\"},{\"inputs\":[],\"name\":\"CallerNotRegisteredOracle\",\"type\":\"error\"},{\"inputs\":[],\"name\":\"DidRequired\",\"type\":\"error\"},{\"inputs\":[],\"name\":\"InvalidOracleCount\",\"type\":\"error\"},{\"inputs\":[],\"name\":\"OracleIdAlreadyRegistered\",\"type\":\"error\"},{\"inputs\":[],\"name\":\"OracleIdOutOfRange\",\"type\":\"error\"},{\"inputs\":[],\"name\":\"OraclesEncryptionKeyRequired\",\"type\":\"error\"},{\"anonymous\":false,\"inputs\":[{\"indexed\":true,\"internalType\":\"uint8\",\"name\":\"oracleId\",\"type\":\"uint8\"},{\"indexed\":true,\"internalType\":\"address\",\"name\":\"account\",\"type\":\"address\"},{\"indexed\":false,\"internalType\":\"string\",\"name\":\"did\",\"type\":\"string\"},{\"indexed\":false,\"internalType\":\"bytes32\",\"name\":\"oraclesEncryptionKey\",\"type\":\"bytes32\"}],\"name\":\"OracleRegistered\",\"type\":\"event\"},{\"inputs\":[{\"internalType\":\"uint8\",\"name\":\"oracleId\",\"type\":\"uint8\"}],\"name\":\"getOracle\",\"outputs\":[{\"components\":[{\"internalType\":\"uint8\",\"name\":\"oracleId\",\"type\":\"uint8\"},{\"internalType\":\"address\",\"name\":\"account\",\"type\":\"address\"},{\"internalType\":\"string\",\"name\":\"did\",\"type\":\"string\"},{\"internalType\":\"bytes32\",\"name\":\"oraclesEncryptionKey\",\"type\":\"bytes32\"},{\"internalType\":\"bool\",\"name\":\"active\",\"type\":\"bool\"},{\"internalType\":\"uint64\",\"name\":\"updatedAt\",\"type\":\"uint64\"}],\"internalType\":\"structCAVSOracleCoordinator.OracleRegistration\",\"name\":\"\",\"type\":\"tuple\"}],\"stateMutability\":\"view\",\"type\":\"function\"},{\"inputs\":[{\"internalType\":\"address\",\"name\":\"account\",\"type\":\"address\"}],\"name\":\"getOracleIdForAccount\",\"outputs\":[{\"internalType\":\"uint8\",\"name\":\"\",\"type\":\"uint8\"}],\"stateMutability\":\"view\",\"type\":\"function\"},{\"inputs\":[],\"name\":\"getRegisteredOracleIds\",\"outputs\":[{\"internalType\":\"uint8[]\",\"name\":\"\",\"type\":\"uint8[]\"}],\"stateMutability\":\"view\",\"type\":\"function\"},{\"inputs\":[{\"internalType\":\"address\",\"name\":\"account\",\"type\":\"address\"}],\"name\":\"isRegisteredOracle\",\"outputs\":[{\"internalType\":\"bool\",\"name\":\"\",\"type\":\"bool\"}],\"stateMutability\":\"view\",\"type\":\"function\"},{\"inputs\":[],\"name\":\"oracleCount\",\"outputs\":[{\"internalType\":\"uint8\",\"name\":\"\",\"type\":\"uint8\"}],\"stateMutability\":\"view\",\"type\":\"function\"},{\"inputs\":[{\"internalType\":\"uint8\",\"name\":\"oracleId\",\"type\":\"uint8\"},{\"internalType\":\"string\",\"name\":\"did\",\"type\":\"string\"},{\"internalType\":\"bytes32\",\"name\":\"oraclesEncryptionKey\",\"type\":\"bytes32\"}],\"name\":\"registerOracle\",\"outputs\":[],\"stateMutability\":\"nonpayable\",\"type\":\"function\"},{\"inputs\":[],\"name\":\"registeredOracleCount\",\"outputs\":[{\"internalType\":\"uint256\",\"name\":\"\",\"type\":\"uint256\"}],\"stateMutability\":\"view\",\"type\":\"function\"},{\"inputs\":[],\"name\":\"requireRegisteredOracleAccount\",\"outputs\":[{\"internalType\":\"uint8\",\"name\":\"oracleId\",\"type\":\"uint8\"}],\"stateMutability\":\"view\",\"type\":\"function\"}]",
	Bin: "0x60a060405234801561000f575f5ffd5b50604051610a39380380610a3983398101604081905261002e9161005c565b8060ff165f0361005157604051630bab4ccd60e31b815260040160405180910390fd5b60ff16608052610083565b5f6020828403121561006c575f5ffd5b815160ff8116811461007c575f5ffd5b9392505050565b6080516109906100a95f395f8181610142015281816101b501526103b601526109905ff3fe608060405234801561000f575f5ffd5b5060043610610085575f3560e01c806347ad95471161005857806347ad954714610128578063613d8fcc1461013d5780637d0c9c9d14610164578063be3dca8e14610179575f5ffd5b80631569aaf914610089578063221ef050146100b25780632911eb21146100c3578063365b518c14610103575b5f5ffd5b61009c610097366004610630565b610181565b6040516100a99190610650565b60405180910390f35b6002546040519081526020016100a9565b6100f36100d13660046106e1565b6001600160a01b03165f90815260016020526040902054610100900460ff1690565b60405190151581526020016100a9565b6101166101113660046106e1565b6102f9565b60405160ff90911681526020016100a9565b610130610341565b6040516100a99190610707565b6101167f000000000000000000000000000000000000000000000000000000000000000081565b61017761017236600461074c565b6103b4565b005b6101166105d1565b6040805160c0810182525f8082526020820181905260609282018390529181018290526080810182905260a08101919091527f000000000000000000000000000000000000000000000000000000000000000060ff168260ff16106101f9576040516329e3850160e11b815260040160405180910390fd5b60ff82165f81815260208181526040918290208054835160c0810185529485526001600160a01b03169184018290526001810180549194929383019161023e906107d1565b80601f016020809104026020016040519081016040528092919081815260200182805461026a906107d1565b80156102b55780601f1061028c576101008083540402835291602001916102b5565b820191905f5260205f20905b81548152906001019060200180831161029857829003601f168201915b5050509183525050600284015460208201526001600160a01b0392909216151560408301529154600160a01b900467ffffffffffffffff1660609091015292915050565b6001600160a01b0381165f9081526001602052604081208054610100900460ff1661033757604051639704dd5160e01b815260040160405180910390fd5b5460ff1692915050565b606060028054806020026020016040519081016040528092919081815260200182805480156103aa57602002820191905f5260205f20905f905b825461010083900a900460ff1681526020600192830181810494850194909303909202910180841161037b5790505b5050505050905090565b7f000000000000000000000000000000000000000000000000000000000000000060ff168460ff16106103fa576040516329e3850160e11b815260040160405180910390fd5b5f82900361041b57604051630554959960e51b815260040160405180910390fd5b80610439576040516304d9c77b60e11b815260040160405180910390fd5b335f9081526001602052604090208054610100900460ff161561047d57805460ff86811691161461047d5760405163cff2d5ad60e01b815260040160405180910390fd5b60ff85165f90815260208190526040902080546001600160a01b0316158015906104b1575080546001600160a01b03163314155b156104cf576040516303d6f7a560e01b815260040160405180910390fd5b8154610100900460ff1661053f57600280546001810182555f91909152602081047f405787fa12a823e0f2b7631cc41b3ba8828b3321ca811111fa75cd3aa3bb5ace01805460ff808a16601f90941661010090810a85810292021990921617909155835461ffff19169091171782555b80546001600160e01b0319163367ffffffffffffffff60a01b191617600160a01b4267ffffffffffffffff16021781556001810161057e858783610869565b5060028101839055604051339060ff8816907f87b7adefd35083a47f376125617785b355e62b0e1e3e697dfe68217dc39da529906105c190899089908990610923565b60405180910390a3505050505050565b335f90815260016020526040812054610100900460ff166106055760405163bef5a81960e01b815260040160405180910390fd5b50335f9081526001602052604090205460ff1690565b803560ff8116811461062b575f5ffd5b919050565b5f60208284031215610640575f5ffd5b6106498261061b565b9392505050565b6020815260ff825116602082015260018060a01b0360208301511660408201525f604083015160c0606084015280518060e0850152806020830161010086015e5f610100828601015260608501516080850152608085015191506106b860a085018315159052565b60a0949094015167ffffffffffffffff1660c08401525050601f909101601f1916016101000190565b5f602082840312156106f1575f5ffd5b81356001600160a01b0381168114610649575f5ffd5b602080825282518282018190525f918401906040840190835b8181101561074157835160ff16835260209384019390920191600101610720565b509095945050505050565b5f5f5f5f6060858703121561075f575f5ffd5b6107688561061b565b9350602085013567ffffffffffffffff811115610783575f5ffd5b8501601f81018713610793575f5ffd5b803567ffffffffffffffff8111156107a9575f5ffd5b8760208284010111156107ba575f5ffd5b949760209190910196509394604001359392505050565b600181811c908216806107e557607f821691505b60208210810361080357634e487b7160e01b5f52602260045260245ffd5b50919050565b634e487b7160e01b5f52604160045260245ffd5b601f82111561086457805f5260205f20601f840160051c810160208510156108425750805b601f840160051c820191505b81811015610861575f815560010161084e565b50505b505050565b67ffffffffffffffff83111561088157610881610809565b6108958361088f83546107d1565b8361081d565b5f601f8411600181146108c6575f85156108af5750838201355b5f19600387901b1c1916600186901b178355610861565b5f83815260208120601f198716915b828110156108f557868501358255602094850194600190920191016108d5565b5086821015610911575f1960f88860031b161c19848701351681555b505060018560011b0183555050505050565b60408152826040820152828460608301375f606084830101525f6060601f19601f860116830101905082602083015294935050505056fea2646970667358221220a98fba099a2f2a2a4dca08bef4c4438ea5bfd76548988a74936f3c734bb7f2b964736f6c634300081c0033",
}

// CAVSOracleCoordinatorABI is the input ABI used to generate the binding from.
// Deprecated: Use CAVSOracleCoordinatorMetaData.ABI instead.
var CAVSOracleCoordinatorABI = CAVSOracleCoordinatorMetaData.ABI

// CAVSOracleCoordinatorBin is the compiled bytecode used for deploying new contracts.
// Deprecated: Use CAVSOracleCoordinatorMetaData.Bin instead.
var CAVSOracleCoordinatorBin = CAVSOracleCoordinatorMetaData.Bin

// DeployCAVSOracleCoordinator deploys a new Ethereum contract, binding an instance of CAVSOracleCoordinator to it.
func DeployCAVSOracleCoordinator(auth *bind.TransactOpts, backend bind.ContractBackend, oracleCount_ uint8) (common.Address, *types.Transaction, *CAVSOracleCoordinator, error) {
	parsed, err := CAVSOracleCoordinatorMetaData.GetAbi()
	if err != nil {
		return common.Address{}, nil, nil, err
	}
	if parsed == nil {
		return common.Address{}, nil, nil, errors.New("GetABI returned nil")
	}

	address, tx, contract, err := bind.DeployContract(auth, *parsed, common.FromHex(CAVSOracleCoordinatorBin), backend, oracleCount_)
	if err != nil {
		return common.Address{}, nil, nil, err
	}
	return address, tx, &CAVSOracleCoordinator{CAVSOracleCoordinatorCaller: CAVSOracleCoordinatorCaller{contract: contract}, CAVSOracleCoordinatorTransactor: CAVSOracleCoordinatorTransactor{contract: contract}, CAVSOracleCoordinatorFilterer: CAVSOracleCoordinatorFilterer{contract: contract}}, nil
}

// CAVSOracleCoordinator is an auto generated Go binding around an Ethereum contract.
type CAVSOracleCoordinator struct {
	CAVSOracleCoordinatorCaller     // Read-only binding to the contract
	CAVSOracleCoordinatorTransactor // Write-only binding to the contract
	CAVSOracleCoordinatorFilterer   // Log filterer for contract events
}

// CAVSOracleCoordinatorCaller is an auto generated read-only Go binding around an Ethereum contract.
type CAVSOracleCoordinatorCaller struct {
	contract *bind.BoundContract // Generic contract wrapper for the low level calls
}

// CAVSOracleCoordinatorTransactor is an auto generated write-only Go binding around an Ethereum contract.
type CAVSOracleCoordinatorTransactor struct {
	contract *bind.BoundContract // Generic contract wrapper for the low level calls
}

// CAVSOracleCoordinatorFilterer is an auto generated log filtering Go binding around an Ethereum contract events.
type CAVSOracleCoordinatorFilterer struct {
	contract *bind.BoundContract // Generic contract wrapper for the low level calls
}

// CAVSOracleCoordinatorSession is an auto generated Go binding around an Ethereum contract,
// with pre-set call and transact options.
type CAVSOracleCoordinatorSession struct {
	Contract     *CAVSOracleCoordinator // Generic contract binding to set the session for
	CallOpts     bind.CallOpts          // Call options to use throughout this session
	TransactOpts bind.TransactOpts      // Transaction auth options to use throughout this session
}

// CAVSOracleCoordinatorCallerSession is an auto generated read-only Go binding around an Ethereum contract,
// with pre-set call options.
type CAVSOracleCoordinatorCallerSession struct {
	Contract *CAVSOracleCoordinatorCaller // Generic contract caller binding to set the session for
	CallOpts bind.CallOpts                // Call options to use throughout this session
}

// CAVSOracleCoordinatorTransactorSession is an auto generated write-only Go binding around an Ethereum contract,
// with pre-set transact options.
type CAVSOracleCoordinatorTransactorSession struct {
	Contract     *CAVSOracleCoordinatorTransactor // Generic contract transactor binding to set the session for
	TransactOpts bind.TransactOpts                // Transaction auth options to use throughout this session
}

// CAVSOracleCoordinatorRaw is an auto generated low-level Go binding around an Ethereum contract.
type CAVSOracleCoordinatorRaw struct {
	Contract *CAVSOracleCoordinator // Generic contract binding to access the raw methods on
}

// CAVSOracleCoordinatorCallerRaw is an auto generated low-level read-only Go binding around an Ethereum contract.
type CAVSOracleCoordinatorCallerRaw struct {
	Contract *CAVSOracleCoordinatorCaller // Generic read-only contract binding to access the raw methods on
}

// CAVSOracleCoordinatorTransactorRaw is an auto generated low-level write-only Go binding around an Ethereum contract.
type CAVSOracleCoordinatorTransactorRaw struct {
	Contract *CAVSOracleCoordinatorTransactor // Generic write-only contract binding to access the raw methods on
}

// NewCAVSOracleCoordinator creates a new instance of CAVSOracleCoordinator, bound to a specific deployed contract.
func NewCAVSOracleCoordinator(address common.Address, backend bind.ContractBackend) (*CAVSOracleCoordinator, error) {
	contract, err := bindCAVSOracleCoordinator(address, backend, backend, backend)
	if err != nil {
		return nil, err
	}
	return &CAVSOracleCoordinator{CAVSOracleCoordinatorCaller: CAVSOracleCoordinatorCaller{contract: contract}, CAVSOracleCoordinatorTransactor: CAVSOracleCoordinatorTransactor{contract: contract}, CAVSOracleCoordinatorFilterer: CAVSOracleCoordinatorFilterer{contract: contract}}, nil
}

// NewCAVSOracleCoordinatorCaller creates a new read-only instance of CAVSOracleCoordinator, bound to a specific deployed contract.
func NewCAVSOracleCoordinatorCaller(address common.Address, caller bind.ContractCaller) (*CAVSOracleCoordinatorCaller, error) {
	contract, err := bindCAVSOracleCoordinator(address, caller, nil, nil)
	if err != nil {
		return nil, err
	}
	return &CAVSOracleCoordinatorCaller{contract: contract}, nil
}

// NewCAVSOracleCoordinatorTransactor creates a new write-only instance of CAVSOracleCoordinator, bound to a specific deployed contract.
func NewCAVSOracleCoordinatorTransactor(address common.Address, transactor bind.ContractTransactor) (*CAVSOracleCoordinatorTransactor, error) {
	contract, err := bindCAVSOracleCoordinator(address, nil, transactor, nil)
	if err != nil {
		return nil, err
	}
	return &CAVSOracleCoordinatorTransactor{contract: contract}, nil
}

// NewCAVSOracleCoordinatorFilterer creates a new log filterer instance of CAVSOracleCoordinator, bound to a specific deployed contract.
func NewCAVSOracleCoordinatorFilterer(address common.Address, filterer bind.ContractFilterer) (*CAVSOracleCoordinatorFilterer, error) {
	contract, err := bindCAVSOracleCoordinator(address, nil, nil, filterer)
	if err != nil {
		return nil, err
	}
	return &CAVSOracleCoordinatorFilterer{contract: contract}, nil
}

// bindCAVSOracleCoordinator binds a generic wrapper to an already deployed contract.
func bindCAVSOracleCoordinator(address common.Address, caller bind.ContractCaller, transactor bind.ContractTransactor, filterer bind.ContractFilterer) (*bind.BoundContract, error) {
	parsed, err := CAVSOracleCoordinatorMetaData.GetAbi()
	if err != nil {
		return nil, err
	}
	return bind.NewBoundContract(address, *parsed, caller, transactor, filterer), nil
}

// Call invokes the (constant) contract method with params as input values and
// sets the output to result. The result type might be a single field for simple
// returns, a slice of interfaces for anonymous returns and a struct for named
// returns.
func (_CAVSOracleCoordinator *CAVSOracleCoordinatorRaw) Call(opts *bind.CallOpts, result *[]interface{}, method string, params ...interface{}) error {
	return _CAVSOracleCoordinator.Contract.CAVSOracleCoordinatorCaller.contract.Call(opts, result, method, params...)
}

// Transfer initiates a plain transaction to move funds to the contract, calling
// its default method if one is available.
func (_CAVSOracleCoordinator *CAVSOracleCoordinatorRaw) Transfer(opts *bind.TransactOpts) (*types.Transaction, error) {
	return _CAVSOracleCoordinator.Contract.CAVSOracleCoordinatorTransactor.contract.Transfer(opts)
}

// Transact invokes the (paid) contract method with params as input values.
func (_CAVSOracleCoordinator *CAVSOracleCoordinatorRaw) Transact(opts *bind.TransactOpts, method string, params ...interface{}) (*types.Transaction, error) {
	return _CAVSOracleCoordinator.Contract.CAVSOracleCoordinatorTransactor.contract.Transact(opts, method, params...)
}

// Call invokes the (constant) contract method with params as input values and
// sets the output to result. The result type might be a single field for simple
// returns, a slice of interfaces for anonymous returns and a struct for named
// returns.
func (_CAVSOracleCoordinator *CAVSOracleCoordinatorCallerRaw) Call(opts *bind.CallOpts, result *[]interface{}, method string, params ...interface{}) error {
	return _CAVSOracleCoordinator.Contract.contract.Call(opts, result, method, params...)
}

// Transfer initiates a plain transaction to move funds to the contract, calling
// its default method if one is available.
func (_CAVSOracleCoordinator *CAVSOracleCoordinatorTransactorRaw) Transfer(opts *bind.TransactOpts) (*types.Transaction, error) {
	return _CAVSOracleCoordinator.Contract.contract.Transfer(opts)
}

// Transact invokes the (paid) contract method with params as input values.
func (_CAVSOracleCoordinator *CAVSOracleCoordinatorTransactorRaw) Transact(opts *bind.TransactOpts, method string, params ...interface{}) (*types.Transaction, error) {
	return _CAVSOracleCoordinator.Contract.contract.Transact(opts, method, params...)
}

// GetOracle is a free data retrieval call binding the contract method 0x1569aaf9.
//
// Solidity: function getOracle(uint8 oracleId) view returns((uint8,address,string,bytes32,bool,uint64))
func (_CAVSOracleCoordinator *CAVSOracleCoordinatorCaller) GetOracle(opts *bind.CallOpts, oracleId uint8) (CAVSOracleCoordinatorOracleRegistration, error) {
	var out []interface{}
	err := _CAVSOracleCoordinator.contract.Call(opts, &out, "getOracle", oracleId)

	if err != nil {
		return *new(CAVSOracleCoordinatorOracleRegistration), err
	}

	out0 := *abi.ConvertType(out[0], new(CAVSOracleCoordinatorOracleRegistration)).(*CAVSOracleCoordinatorOracleRegistration)

	return out0, err

}

// GetOracle is a free data retrieval call binding the contract method 0x1569aaf9.
//
// Solidity: function getOracle(uint8 oracleId) view returns((uint8,address,string,bytes32,bool,uint64))
func (_CAVSOracleCoordinator *CAVSOracleCoordinatorSession) GetOracle(oracleId uint8) (CAVSOracleCoordinatorOracleRegistration, error) {
	return _CAVSOracleCoordinator.Contract.GetOracle(&_CAVSOracleCoordinator.CallOpts, oracleId)
}

// GetOracle is a free data retrieval call binding the contract method 0x1569aaf9.
//
// Solidity: function getOracle(uint8 oracleId) view returns((uint8,address,string,bytes32,bool,uint64))
func (_CAVSOracleCoordinator *CAVSOracleCoordinatorCallerSession) GetOracle(oracleId uint8) (CAVSOracleCoordinatorOracleRegistration, error) {
	return _CAVSOracleCoordinator.Contract.GetOracle(&_CAVSOracleCoordinator.CallOpts, oracleId)
}

// GetOracleIdForAccount is a free data retrieval call binding the contract method 0x365b518c.
//
// Solidity: function getOracleIdForAccount(address account) view returns(uint8)
func (_CAVSOracleCoordinator *CAVSOracleCoordinatorCaller) GetOracleIdForAccount(opts *bind.CallOpts, account common.Address) (uint8, error) {
	var out []interface{}
	err := _CAVSOracleCoordinator.contract.Call(opts, &out, "getOracleIdForAccount", account)

	if err != nil {
		return *new(uint8), err
	}

	out0 := *abi.ConvertType(out[0], new(uint8)).(*uint8)

	return out0, err

}

// GetOracleIdForAccount is a free data retrieval call binding the contract method 0x365b518c.
//
// Solidity: function getOracleIdForAccount(address account) view returns(uint8)
func (_CAVSOracleCoordinator *CAVSOracleCoordinatorSession) GetOracleIdForAccount(account common.Address) (uint8, error) {
	return _CAVSOracleCoordinator.Contract.GetOracleIdForAccount(&_CAVSOracleCoordinator.CallOpts, account)
}

// GetOracleIdForAccount is a free data retrieval call binding the contract method 0x365b518c.
//
// Solidity: function getOracleIdForAccount(address account) view returns(uint8)
func (_CAVSOracleCoordinator *CAVSOracleCoordinatorCallerSession) GetOracleIdForAccount(account common.Address) (uint8, error) {
	return _CAVSOracleCoordinator.Contract.GetOracleIdForAccount(&_CAVSOracleCoordinator.CallOpts, account)
}

// GetRegisteredOracleIds is a free data retrieval call binding the contract method 0x47ad9547.
//
// Solidity: function getRegisteredOracleIds() view returns(uint8[])
func (_CAVSOracleCoordinator *CAVSOracleCoordinatorCaller) GetRegisteredOracleIds(opts *bind.CallOpts) ([]uint8, error) {
	var out []interface{}
	err := _CAVSOracleCoordinator.contract.Call(opts, &out, "getRegisteredOracleIds")

	if err != nil {
		return *new([]uint8), err
	}

	out0 := *abi.ConvertType(out[0], new([]uint8)).(*[]uint8)

	return out0, err

}

// GetRegisteredOracleIds is a free data retrieval call binding the contract method 0x47ad9547.
//
// Solidity: function getRegisteredOracleIds() view returns(uint8[])
func (_CAVSOracleCoordinator *CAVSOracleCoordinatorSession) GetRegisteredOracleIds() ([]uint8, error) {
	return _CAVSOracleCoordinator.Contract.GetRegisteredOracleIds(&_CAVSOracleCoordinator.CallOpts)
}

// GetRegisteredOracleIds is a free data retrieval call binding the contract method 0x47ad9547.
//
// Solidity: function getRegisteredOracleIds() view returns(uint8[])
func (_CAVSOracleCoordinator *CAVSOracleCoordinatorCallerSession) GetRegisteredOracleIds() ([]uint8, error) {
	return _CAVSOracleCoordinator.Contract.GetRegisteredOracleIds(&_CAVSOracleCoordinator.CallOpts)
}

// IsRegisteredOracle is a free data retrieval call binding the contract method 0x2911eb21.
//
// Solidity: function isRegisteredOracle(address account) view returns(bool)
func (_CAVSOracleCoordinator *CAVSOracleCoordinatorCaller) IsRegisteredOracle(opts *bind.CallOpts, account common.Address) (bool, error) {
	var out []interface{}
	err := _CAVSOracleCoordinator.contract.Call(opts, &out, "isRegisteredOracle", account)

	if err != nil {
		return *new(bool), err
	}

	out0 := *abi.ConvertType(out[0], new(bool)).(*bool)

	return out0, err

}

// IsRegisteredOracle is a free data retrieval call binding the contract method 0x2911eb21.
//
// Solidity: function isRegisteredOracle(address account) view returns(bool)
func (_CAVSOracleCoordinator *CAVSOracleCoordinatorSession) IsRegisteredOracle(account common.Address) (bool, error) {
	return _CAVSOracleCoordinator.Contract.IsRegisteredOracle(&_CAVSOracleCoordinator.CallOpts, account)
}

// IsRegisteredOracle is a free data retrieval call binding the contract method 0x2911eb21.
//
// Solidity: function isRegisteredOracle(address account) view returns(bool)
func (_CAVSOracleCoordinator *CAVSOracleCoordinatorCallerSession) IsRegisteredOracle(account common.Address) (bool, error) {
	return _CAVSOracleCoordinator.Contract.IsRegisteredOracle(&_CAVSOracleCoordinator.CallOpts, account)
}

// OracleCount is a free data retrieval call binding the contract method 0x613d8fcc.
//
// Solidity: function oracleCount() view returns(uint8)
func (_CAVSOracleCoordinator *CAVSOracleCoordinatorCaller) OracleCount(opts *bind.CallOpts) (uint8, error) {
	var out []interface{}
	err := _CAVSOracleCoordinator.contract.Call(opts, &out, "oracleCount")

	if err != nil {
		return *new(uint8), err
	}

	out0 := *abi.ConvertType(out[0], new(uint8)).(*uint8)

	return out0, err

}

// OracleCount is a free data retrieval call binding the contract method 0x613d8fcc.
//
// Solidity: function oracleCount() view returns(uint8)
func (_CAVSOracleCoordinator *CAVSOracleCoordinatorSession) OracleCount() (uint8, error) {
	return _CAVSOracleCoordinator.Contract.OracleCount(&_CAVSOracleCoordinator.CallOpts)
}

// OracleCount is a free data retrieval call binding the contract method 0x613d8fcc.
//
// Solidity: function oracleCount() view returns(uint8)
func (_CAVSOracleCoordinator *CAVSOracleCoordinatorCallerSession) OracleCount() (uint8, error) {
	return _CAVSOracleCoordinator.Contract.OracleCount(&_CAVSOracleCoordinator.CallOpts)
}

// RegisteredOracleCount is a free data retrieval call binding the contract method 0x221ef050.
//
// Solidity: function registeredOracleCount() view returns(uint256)
func (_CAVSOracleCoordinator *CAVSOracleCoordinatorCaller) RegisteredOracleCount(opts *bind.CallOpts) (*big.Int, error) {
	var out []interface{}
	err := _CAVSOracleCoordinator.contract.Call(opts, &out, "registeredOracleCount")

	if err != nil {
		return *new(*big.Int), err
	}

	out0 := *abi.ConvertType(out[0], new(*big.Int)).(**big.Int)

	return out0, err

}

// RegisteredOracleCount is a free data retrieval call binding the contract method 0x221ef050.
//
// Solidity: function registeredOracleCount() view returns(uint256)
func (_CAVSOracleCoordinator *CAVSOracleCoordinatorSession) RegisteredOracleCount() (*big.Int, error) {
	return _CAVSOracleCoordinator.Contract.RegisteredOracleCount(&_CAVSOracleCoordinator.CallOpts)
}

// RegisteredOracleCount is a free data retrieval call binding the contract method 0x221ef050.
//
// Solidity: function registeredOracleCount() view returns(uint256)
func (_CAVSOracleCoordinator *CAVSOracleCoordinatorCallerSession) RegisteredOracleCount() (*big.Int, error) {
	return _CAVSOracleCoordinator.Contract.RegisteredOracleCount(&_CAVSOracleCoordinator.CallOpts)
}

// RequireRegisteredOracleAccount is a free data retrieval call binding the contract method 0xbe3dca8e.
//
// Solidity: function requireRegisteredOracleAccount() view returns(uint8 oracleId)
func (_CAVSOracleCoordinator *CAVSOracleCoordinatorCaller) RequireRegisteredOracleAccount(opts *bind.CallOpts) (uint8, error) {
	var out []interface{}
	err := _CAVSOracleCoordinator.contract.Call(opts, &out, "requireRegisteredOracleAccount")

	if err != nil {
		return *new(uint8), err
	}

	out0 := *abi.ConvertType(out[0], new(uint8)).(*uint8)

	return out0, err

}

// RequireRegisteredOracleAccount is a free data retrieval call binding the contract method 0xbe3dca8e.
//
// Solidity: function requireRegisteredOracleAccount() view returns(uint8 oracleId)
func (_CAVSOracleCoordinator *CAVSOracleCoordinatorSession) RequireRegisteredOracleAccount() (uint8, error) {
	return _CAVSOracleCoordinator.Contract.RequireRegisteredOracleAccount(&_CAVSOracleCoordinator.CallOpts)
}

// RequireRegisteredOracleAccount is a free data retrieval call binding the contract method 0xbe3dca8e.
//
// Solidity: function requireRegisteredOracleAccount() view returns(uint8 oracleId)
func (_CAVSOracleCoordinator *CAVSOracleCoordinatorCallerSession) RequireRegisteredOracleAccount() (uint8, error) {
	return _CAVSOracleCoordinator.Contract.RequireRegisteredOracleAccount(&_CAVSOracleCoordinator.CallOpts)
}

// RegisterOracle is a paid mutator transaction binding the contract method 0x7d0c9c9d.
//
// Solidity: function registerOracle(uint8 oracleId, string did, bytes32 oraclesEncryptionKey) returns()
func (_CAVSOracleCoordinator *CAVSOracleCoordinatorTransactor) RegisterOracle(opts *bind.TransactOpts, oracleId uint8, did string, oraclesEncryptionKey [32]byte) (*types.Transaction, error) {
	return _CAVSOracleCoordinator.contract.Transact(opts, "registerOracle", oracleId, did, oraclesEncryptionKey)
}

// RegisterOracle is a paid mutator transaction binding the contract method 0x7d0c9c9d.
//
// Solidity: function registerOracle(uint8 oracleId, string did, bytes32 oraclesEncryptionKey) returns()
func (_CAVSOracleCoordinator *CAVSOracleCoordinatorSession) RegisterOracle(oracleId uint8, did string, oraclesEncryptionKey [32]byte) (*types.Transaction, error) {
	return _CAVSOracleCoordinator.Contract.RegisterOracle(&_CAVSOracleCoordinator.TransactOpts, oracleId, did, oraclesEncryptionKey)
}

// RegisterOracle is a paid mutator transaction binding the contract method 0x7d0c9c9d.
//
// Solidity: function registerOracle(uint8 oracleId, string did, bytes32 oraclesEncryptionKey) returns()
func (_CAVSOracleCoordinator *CAVSOracleCoordinatorTransactorSession) RegisterOracle(oracleId uint8, did string, oraclesEncryptionKey [32]byte) (*types.Transaction, error) {
	return _CAVSOracleCoordinator.Contract.RegisterOracle(&_CAVSOracleCoordinator.TransactOpts, oracleId, did, oraclesEncryptionKey)
}

// CAVSOracleCoordinatorOracleRegisteredIterator is returned from FilterOracleRegistered and is used to iterate over the raw logs and unpacked data for OracleRegistered events raised by the CAVSOracleCoordinator contract.
type CAVSOracleCoordinatorOracleRegisteredIterator struct {
	Event *CAVSOracleCoordinatorOracleRegistered // Event containing the contract specifics and raw log

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
func (it *CAVSOracleCoordinatorOracleRegisteredIterator) Next() bool {
	// If the iterator failed, stop iterating
	if it.fail != nil {
		return false
	}
	// If the iterator completed, deliver directly whatever's available
	if it.done {
		select {
		case log := <-it.logs:
			it.Event = new(CAVSOracleCoordinatorOracleRegistered)
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
		it.Event = new(CAVSOracleCoordinatorOracleRegistered)
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
func (it *CAVSOracleCoordinatorOracleRegisteredIterator) Error() error {
	return it.fail
}

// Close terminates the iteration process, releasing any pending underlying
// resources.
func (it *CAVSOracleCoordinatorOracleRegisteredIterator) Close() error {
	it.sub.Unsubscribe()
	return nil
}

// CAVSOracleCoordinatorOracleRegistered represents a OracleRegistered event raised by the CAVSOracleCoordinator contract.
type CAVSOracleCoordinatorOracleRegistered struct {
	OracleId             uint8
	Account              common.Address
	Did                  string
	OraclesEncryptionKey [32]byte
	Raw                  types.Log // Blockchain specific contextual infos
}

// FilterOracleRegistered is a free log retrieval operation binding the contract event 0x87b7adefd35083a47f376125617785b355e62b0e1e3e697dfe68217dc39da529.
//
// Solidity: event OracleRegistered(uint8 indexed oracleId, address indexed account, string did, bytes32 oraclesEncryptionKey)
func (_CAVSOracleCoordinator *CAVSOracleCoordinatorFilterer) FilterOracleRegistered(opts *bind.FilterOpts, oracleId []uint8, account []common.Address) (*CAVSOracleCoordinatorOracleRegisteredIterator, error) {

	var oracleIdRule []interface{}
	for _, oracleIdItem := range oracleId {
		oracleIdRule = append(oracleIdRule, oracleIdItem)
	}
	var accountRule []interface{}
	for _, accountItem := range account {
		accountRule = append(accountRule, accountItem)
	}

	logs, sub, err := _CAVSOracleCoordinator.contract.FilterLogs(opts, "OracleRegistered", oracleIdRule, accountRule)
	if err != nil {
		return nil, err
	}
	return &CAVSOracleCoordinatorOracleRegisteredIterator{contract: _CAVSOracleCoordinator.contract, event: "OracleRegistered", logs: logs, sub: sub}, nil
}

// WatchOracleRegistered is a free log subscription operation binding the contract event 0x87b7adefd35083a47f376125617785b355e62b0e1e3e697dfe68217dc39da529.
//
// Solidity: event OracleRegistered(uint8 indexed oracleId, address indexed account, string did, bytes32 oraclesEncryptionKey)
func (_CAVSOracleCoordinator *CAVSOracleCoordinatorFilterer) WatchOracleRegistered(opts *bind.WatchOpts, sink chan<- *CAVSOracleCoordinatorOracleRegistered, oracleId []uint8, account []common.Address) (event.Subscription, error) {

	var oracleIdRule []interface{}
	for _, oracleIdItem := range oracleId {
		oracleIdRule = append(oracleIdRule, oracleIdItem)
	}
	var accountRule []interface{}
	for _, accountItem := range account {
		accountRule = append(accountRule, accountItem)
	}

	logs, sub, err := _CAVSOracleCoordinator.contract.WatchLogs(opts, "OracleRegistered", oracleIdRule, accountRule)
	if err != nil {
		return nil, err
	}
	return event.NewSubscription(func(quit <-chan struct{}) error {
		defer sub.Unsubscribe()
		for {
			select {
			case log := <-logs:
				// New log arrived, parse the event and forward to the user
				event := new(CAVSOracleCoordinatorOracleRegistered)
				if err := _CAVSOracleCoordinator.contract.UnpackLog(event, "OracleRegistered", log); err != nil {
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

// ParseOracleRegistered is a log parse operation binding the contract event 0x87b7adefd35083a47f376125617785b355e62b0e1e3e697dfe68217dc39da529.
//
// Solidity: event OracleRegistered(uint8 indexed oracleId, address indexed account, string did, bytes32 oraclesEncryptionKey)
func (_CAVSOracleCoordinator *CAVSOracleCoordinatorFilterer) ParseOracleRegistered(log types.Log) (*CAVSOracleCoordinatorOracleRegistered, error) {
	event := new(CAVSOracleCoordinatorOracleRegistered)
	if err := _CAVSOracleCoordinator.contract.UnpackLog(event, "OracleRegistered", log); err != nil {
		return nil, err
	}
	event.Raw = log
	return event, nil
}
