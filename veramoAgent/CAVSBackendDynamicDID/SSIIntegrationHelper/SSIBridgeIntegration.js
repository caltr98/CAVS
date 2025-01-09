import { identity } from "deso-protocol";
import {CryptoService } from "deso-protocol"
import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';

const desoApp  = express();

desoApp.use(cors());
desoApp.use(bodyParser.json());

desoApp.get("/api/v0/get-user-eth-addr", async (req, res) => {
    try {

        let DeSoKey = req.query.key;  // Use req.query.key to get the key from query parameters
        console.log("desokey " + DeSoKey)
        let eth_key = identity.desoAddressToEthereumAddress(DeSoKey)
        console.log("ethkey " + eth_key)
        res.json({ethereumAddress: eth_key});
    } catch (error) {
        console.log(error)
        res.status(500).json({error: error.message});
    }
});


desoApp.get("/api/v0/get-key-pair", (req, res) => {
    try {
        let seedHex = req.query.seedHex;  // Use req.query.seedHex to get the seedHex from query parameters
        console.log("seedHex " + seedHex);
        let keyPair = seedHexToKeyPair(seedHex);
        console.log("keyPair " + keyPair);
        res.json({
            publicKey: keyPair.getPublic('hex'),
            privateKey: keyPair.getPrivate('hex')
        });
    } catch (error) {
        console.log(error);
        res.status(500).json({ error: error.message });
    }
});

function seedHexToKeyPair(seedHex) {
    const ec = new EC('secp256k1');
    return ec.keyFromPrivate(seedHex);
}


const PORT = 17005;
desoApp.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
