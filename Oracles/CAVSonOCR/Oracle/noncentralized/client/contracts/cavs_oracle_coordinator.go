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
	OracleId  uint8
	Account   common.Address
	Did       string
	Endpoint  string
	Active    bool
	UpdatedAt uint64
}

// CAVSOracleCoordinatorMetaData contains all meta data concerning the CAVSOracleCoordinator contract.
var CAVSOracleCoordinatorMetaData = &bind.MetaData{
	ABI: "[{\"inputs\":[{\"internalType\":\"uint8\",\"name\":\"oracleCount_\",\"type\":\"uint8\"}],\"stateMutability\":\"nonpayable\",\"type\":\"constructor\"},{\"inputs\":[],\"name\":\"AccountAlreadyRegistered\",\"type\":\"error\"},{\"inputs\":[],\"name\":\"AccountNotRegistered\",\"type\":\"error\"},{\"inputs\":[],\"name\":\"CallerNotRegisteredOracle\",\"type\":\"error\"},{\"inputs\":[],\"name\":\"DidRequired\",\"type\":\"error\"},{\"inputs\":[],\"name\":\"EndpointRequired\",\"type\":\"error\"},{\"inputs\":[],\"name\":\"InvalidOracleCount\",\"type\":\"error\"},{\"inputs\":[],\"name\":\"OracleIdAlreadyRegistered\",\"type\":\"error\"},{\"inputs\":[],\"name\":\"OracleIdOutOfRange\",\"type\":\"error\"},{\"anonymous\":false,\"inputs\":[{\"indexed\":true,\"internalType\":\"uint8\",\"name\":\"oracleId\",\"type\":\"uint8\"},{\"indexed\":true,\"internalType\":\"address\",\"name\":\"account\",\"type\":\"address\"},{\"indexed\":false,\"internalType\":\"string\",\"name\":\"did\",\"type\":\"string\"},{\"indexed\":false,\"internalType\":\"string\",\"name\":\"endpoint\",\"type\":\"string\"}],\"name\":\"OracleRegistered\",\"type\":\"event\"},{\"inputs\":[{\"internalType\":\"uint8\",\"name\":\"oracleId\",\"type\":\"uint8\"}],\"name\":\"getOracle\",\"outputs\":[{\"components\":[{\"internalType\":\"uint8\",\"name\":\"oracleId\",\"type\":\"uint8\"},{\"internalType\":\"address\",\"name\":\"account\",\"type\":\"address\"},{\"internalType\":\"string\",\"name\":\"did\",\"type\":\"string\"},{\"internalType\":\"string\",\"name\":\"endpoint\",\"type\":\"string\"},{\"internalType\":\"bool\",\"name\":\"active\",\"type\":\"bool\"},{\"internalType\":\"uint64\",\"name\":\"updatedAt\",\"type\":\"uint64\"}],\"internalType\":\"structCAVSOracleCoordinator.OracleRegistration\",\"name\":\"\",\"type\":\"tuple\"}],\"stateMutability\":\"view\",\"type\":\"function\"},{\"inputs\":[{\"internalType\":\"address\",\"name\":\"account\",\"type\":\"address\"}],\"name\":\"getOracleIdForAccount\",\"outputs\":[{\"internalType\":\"uint8\",\"name\":\"\",\"type\":\"uint8\"}],\"stateMutability\":\"view\",\"type\":\"function\"},{\"inputs\":[],\"name\":\"getRegisteredOracleIds\",\"outputs\":[{\"internalType\":\"uint8[]\",\"name\":\"\",\"type\":\"uint8[]\"}],\"stateMutability\":\"view\",\"type\":\"function\"},{\"inputs\":[{\"internalType\":\"address\",\"name\":\"account\",\"type\":\"address\"}],\"name\":\"isRegisteredOracle\",\"outputs\":[{\"internalType\":\"bool\",\"name\":\"\",\"type\":\"bool\"}],\"stateMutability\":\"view\",\"type\":\"function\"},{\"inputs\":[],\"name\":\"oracleCount\",\"outputs\":[{\"internalType\":\"uint8\",\"name\":\"\",\"type\":\"uint8\"}],\"stateMutability\":\"view\",\"type\":\"function\"},{\"inputs\":[{\"internalType\":\"uint8\",\"name\":\"oracleId\",\"type\":\"uint8\"},{\"internalType\":\"string\",\"name\":\"did\",\"type\":\"string\"},{\"internalType\":\"string\",\"name\":\"endpoint\",\"type\":\"string\"}],\"name\":\"registerOracle\",\"outputs\":[],\"stateMutability\":\"nonpayable\",\"type\":\"function\"},{\"inputs\":[],\"name\":\"registeredOracleCount\",\"outputs\":[{\"internalType\":\"uint256\",\"name\":\"\",\"type\":\"uint256\"}],\"stateMutability\":\"view\",\"type\":\"function\"},{\"inputs\":[],\"name\":\"requireRegisteredOracleAccount\",\"outputs\":[{\"internalType\":\"uint8\",\"name\":\"oracleId\",\"type\":\"uint8\"}],\"stateMutability\":\"view\",\"type\":\"function\"}]",
	Bin: "0x60a060405234801561001057600080fd5b50604051610baf380380610baf83398101604081905261002f9161005e565b8060ff1660000361005357604051630bab4ccd60e31b815260040160405180910390fd5b60ff16608052610088565b60006020828403121561007057600080fd5b815160ff8116811461008157600080fd5b9392505050565b608051610afe6100b160003960008181610147015281816101bc015261044c0152610afe6000f3fe608060405234801561001057600080fd5b50600436106100885760003560e01c806347ad95471161005b57806347ad95471461012d578063613d8fcc1461014257806390f349a814610169578063be3dca8e1461017e57600080fd5b80631569aaf91461008d578063221ef050146100b65780632911eb21146100c7578063365b518c14610108575b600080fd5b6100a061009b3660046106e3565b610186565b6040516100ad919061074b565b60405180910390f35b6002546040519081526020016100ad565b6100f86100d53660046107d0565b6001600160a01b0316600090815260016020526040902054610100900460ff1690565b60405190151581526020016100ad565b61011b6101163660046107d0565b61038b565b60405160ff90911681526020016100ad565b6101356103d4565b6040516100ad91906107f9565b61011b7f000000000000000000000000000000000000000000000000000000000000000081565b61017c610177366004610888565b61044a565b005b61011b610681565b6040805160c0810182526000808252602082018190526060928201839052828201929092526080810182905260a08101919091527f000000000000000000000000000000000000000000000000000000000000000060ff168260ff1610610200576040516329e3850160e11b815260040160405180910390fd5b60ff8216600081815260208181526040918290208054835160c0810185529485526001600160a01b0316918401829052600181018054919492938301916102469061090e565b80601f01602080910402602001604051908101604052809291908181526020018280546102729061090e565b80156102bf5780601f10610294576101008083540402835291602001916102bf565b820191906000526020600020905b8154815290600101906020018083116102a257829003601f168201915b505050505081526020018360020180546102d89061090e565b80601f01602080910402602001604051908101604052809291908181526020018280546103049061090e565b80156103515780601f1061032657610100808354040283529160200191610351565b820191906000526020600020905b81548152906001019060200180831161033457829003601f168201915b50505091835250506001600160a01b0392909216151560208301529154600160a01b900467ffffffffffffffff1660409091015292915050565b6001600160a01b03811660009081526001602052604081208054610100900460ff166103ca57604051639704dd5160e01b815260040160405180910390fd5b5460ff1692915050565b6060600280548060200260200160405190810160405280929190818152602001828054801561044057602002820191906000526020600020906000905b825461010083900a900460ff168152602060019283018181049485019490930390920291018084116104115790505b5050505050905090565b7f000000000000000000000000000000000000000000000000000000000000000060ff168560ff1610610490576040516329e3850160e11b815260040160405180910390fd5b60008390036104b257604051630554959960e51b815260040160405180910390fd5b60008190036104d457604051634e11835360e11b815260040160405180910390fd5b3360009081526001602052604090208054610100900460ff161561051957805460ff8781169116146105195760405163cff2d5ad60e01b815260040160405180910390fd5b60ff8616600090815260208190526040902080546001600160a01b03161580159061054e575080546001600160a01b03163314155b1561056c576040516303d6f7a560e01b815260040160405180910390fd5b8154610100900460ff166105dd5760028054600181018255600091909152602081047f405787fa12a823e0f2b7631cc41b3ba8828b3321ca811111fa75cd3aa3bb5ace01805460ff808b16601f90941661010090810a85810292021990921617909155835461ffff19169091171782555b80546001600160e01b0319163367ffffffffffffffff60a01b191617600160a01b4267ffffffffffffffff16021781556001810161061c8688836109ad565b506002810161062c8486836109ad565b50336001600160a01b03168760ff167f98ec1736274739321b8d4373074cbbdd0584c76494bd631fec77bd18a10b47f9888888886040516106709493929190610a96565b60405180910390a350505050505050565b33600090815260016020526040812054610100900460ff166106b65760405163bef5a81960e01b815260040160405180910390fd5b503360009081526001602052604090205460ff1690565b803560ff811681146106de57600080fd5b919050565b6000602082840312156106f557600080fd5b6106fe826106cd565b9392505050565b6000815180845260005b8181101561072b5760208185018101518683018201520161070f565b506000602082860101526020601f19601f83011685010191505092915050565b6020815260ff825116602082015260018060a01b0360208301511660408201526000604083015160c0606084015261078660e0840182610705565b90506060840151601f198483030160808501526107a38282610705565b9150506080840151151560a084015267ffffffffffffffff60a08501511660c08401528091505092915050565b6000602082840312156107e257600080fd5b81356001600160a01b03811681146106fe57600080fd5b602080825282518282018190526000918401906040840190835b8181101561083457835160ff16835260209384019390920191600101610813565b509095945050505050565b60008083601f84011261085157600080fd5b50813567ffffffffffffffff81111561086957600080fd5b60208301915083602082850101111561088157600080fd5b9250929050565b6000806000806000606086880312156108a057600080fd5b6108a9866106cd565b9450602086013567ffffffffffffffff8111156108c557600080fd5b6108d18882890161083f565b909550935050604086013567ffffffffffffffff8111156108f157600080fd5b6108fd8882890161083f565b969995985093965092949392505050565b600181811c9082168061092257607f821691505b60208210810361094257634e487b7160e01b600052602260045260246000fd5b50919050565b634e487b7160e01b600052604160045260246000fd5b601f8211156109a857806000526020600020601f840160051c810160208510156109855750805b601f840160051c820191505b818110156109a55760008155600101610991565b50505b505050565b67ffffffffffffffff8311156109c5576109c5610948565b6109d9836109d3835461090e565b8361095e565b6000601f841160018114610a0d57600085156109f55750838201355b600019600387901b1c1916600186901b1783556109a5565b600083815260209020601f19861690835b82811015610a3e5786850135825560209485019460019092019101610a1e565b5086821015610a5b5760001960f88860031b161c19848701351681555b505060018560011b0183555050505050565b81835281816020850137506000828201602090810191909152601f909101601f19169091010190565b604081526000610aaa604083018688610a6d565b8281036020840152610abd818587610a6d565b97965050505050505056fea2646970667358221220770ba741f94c1d329b208b82868e043a48fc7c529f098096f27967e3a7c6b0b764736f6c634300081c0033",
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
// Solidity: function getOracle(uint8 oracleId) view returns((uint8,address,string,string,bool,uint64))
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
// Solidity: function getOracle(uint8 oracleId) view returns((uint8,address,string,string,bool,uint64))
func (_CAVSOracleCoordinator *CAVSOracleCoordinatorSession) GetOracle(oracleId uint8) (CAVSOracleCoordinatorOracleRegistration, error) {
	return _CAVSOracleCoordinator.Contract.GetOracle(&_CAVSOracleCoordinator.CallOpts, oracleId)
}

// GetOracle is a free data retrieval call binding the contract method 0x1569aaf9.
//
// Solidity: function getOracle(uint8 oracleId) view returns((uint8,address,string,string,bool,uint64))
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

// RegisterOracle is a paid mutator transaction binding the contract method 0x90f349a8.
//
// Solidity: function registerOracle(uint8 oracleId, string did, string endpoint) returns()
func (_CAVSOracleCoordinator *CAVSOracleCoordinatorTransactor) RegisterOracle(opts *bind.TransactOpts, oracleId uint8, did string, endpoint string) (*types.Transaction, error) {
	return _CAVSOracleCoordinator.contract.Transact(opts, "registerOracle", oracleId, did, endpoint)
}

// RegisterOracle is a paid mutator transaction binding the contract method 0x90f349a8.
//
// Solidity: function registerOracle(uint8 oracleId, string did, string endpoint) returns()
func (_CAVSOracleCoordinator *CAVSOracleCoordinatorSession) RegisterOracle(oracleId uint8, did string, endpoint string) (*types.Transaction, error) {
	return _CAVSOracleCoordinator.Contract.RegisterOracle(&_CAVSOracleCoordinator.TransactOpts, oracleId, did, endpoint)
}

// RegisterOracle is a paid mutator transaction binding the contract method 0x90f349a8.
//
// Solidity: function registerOracle(uint8 oracleId, string did, string endpoint) returns()
func (_CAVSOracleCoordinator *CAVSOracleCoordinatorTransactorSession) RegisterOracle(oracleId uint8, did string, endpoint string) (*types.Transaction, error) {
	return _CAVSOracleCoordinator.Contract.RegisterOracle(&_CAVSOracleCoordinator.TransactOpts, oracleId, did, endpoint)
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
	OracleId uint8
	Account  common.Address
	Did      string
	Endpoint string
	Raw      types.Log // Blockchain specific contextual infos
}

// FilterOracleRegistered is a free log retrieval operation binding the contract event 0x98ec1736274739321b8d4373074cbbdd0584c76494bd631fec77bd18a10b47f9.
//
// Solidity: event OracleRegistered(uint8 indexed oracleId, address indexed account, string did, string endpoint)
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

// WatchOracleRegistered is a free log subscription operation binding the contract event 0x98ec1736274739321b8d4373074cbbdd0584c76494bd631fec77bd18a10b47f9.
//
// Solidity: event OracleRegistered(uint8 indexed oracleId, address indexed account, string did, string endpoint)
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

// ParseOracleRegistered is a log parse operation binding the contract event 0x98ec1736274739321b8d4373074cbbdd0584c76494bd631fec77bd18a10b47f9.
//
// Solidity: event OracleRegistered(uint8 indexed oracleId, address indexed account, string did, string endpoint)
func (_CAVSOracleCoordinator *CAVSOracleCoordinatorFilterer) ParseOracleRegistered(log types.Log) (*CAVSOracleCoordinatorOracleRegistered, error) {
	event := new(CAVSOracleCoordinatorOracleRegistered)
	if err := _CAVSOracleCoordinator.contract.UnpackLog(event, "OracleRegistered", log); err != nil {
		return nil, err
	}
	event.Raw = log
	return event, nil
}
