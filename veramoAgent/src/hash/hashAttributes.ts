import process from 'process';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const util = require('util');

let crypto: any;
const config = {
    "maxClaims": 11,
    "runs" : 30,
    "mnemonic": "family dress industry stage bike shrimp replace design author amateur reopen script",
    "disclosedClaims" : 0.75,
    "original":{

    },
    "symmetricKey":{
        "K":"aes-128-cbc",
        "symmetrickeylength":128
    },
    "hash":{
        "H":"sha3-256",
        "keylength": 512
    },
    "merkleTree":{
        "HLeaves":"keccak256",
        "keyLengthHLeaves":256,
        "HTree": "sha3-256"
    },
    "merklePatriciaTree":{
        "HTree": "none",
        "HLeaves":"keccak256",
        "keyLength":256
    },
    "atomic":{
    }
}


// Define the shape of the hashAttributes return type
interface HashAttributesResult {
    nonce: string;
    res: string;
}

try {
    crypto = require('crypto');
    let h = await crypto.getHashes();
    console.log("Available hash algorithms..");
    console.log(h);
}catch (err){
    console.log('crypto support is disabled');
    process.exit();
}


const generateKey = util.promisify(crypto.generateKey);


// in order to implement the possibility of selective disclosure
// the issuer provides the VC with hashed values of all the claims
// for each claim the issuer uses a different nonce during hashing
export const hashAttributes = async (attribute:any, key:any = undefined, keylength:any = config.hash.keylength, type:any =config.hash.H) => {
    //console.log("Key length "+keylength);
    //console.log("Hashing "+type);
    if(!key){
        key = await generateKey('hmac',{length:keylength});
        key = key.export().toString('hex');
    }
    //console.log("Key  "+key);

    const hmac = await crypto.createHmac(type,key);
    hmac.update(attribute);
    const result = hmac.digest('hex');
    return { nonce: key, res: result};
}






