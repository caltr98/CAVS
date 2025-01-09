const { Crypto } = require('@peculiar/webcrypto')
const selectHashFunction = require("./hash");
const peculiarWebcrypto = new Crypto()
peculiarWebcrypto.createHash = selectHashFunction(peculiarWebcrypto);
module.exports = peculiarWebcrypto
