// Import Express
import express, { Request, Response } from 'express';
import cors from 'cors';
// Import axios
import axios from 'axios';
import qrcode from 'qrcode'
import { agent } from './src/veramo/setup.js'
import {CredentialSubject, ICredentialIssuer, IDIDManagerGetArgs, IIdentifier,VerifiableCredential} from "@veramo/core";
import { Decoder } from '@nuintun/qrcode';
import QrScanner from 'qr-scanner'; // if installed via package and bundling with a module bundler like webpack or rollup
import fs from 'fs'
import  decode from 'jsqr'
import PNGReader from 'png.js'
// Create an app instance
import { BrowserQRCodeReader } from '@zxing/browser';
import {PNG} from 'pngjs'
import jpeg from 'jpeg-js'
import { jwtDecode } from "jwt-decode";

const app = express();

// Enable CORS
app.use(cors());

// Define a type for the user object
interface User {
    name: string;
    email: string;
    password: string;
}



app.get("/create_did_by_alias", async (req: Request, res: Response) => {
    let gotalias:string = <string>req.query.alias

    const identifier = await agent.didManagerCreate({ alias: gotalias })
    res.send(identifier);
});


// Define a route that returns a list of dids from the wallet
app.get('/get_own_did', async (req: Request, res: Response) => {
    const identifiers = await agent.didManagerFind()
    console.log(`There are ${identifiers.length} identifiers`)

    let list: string[] = []
    if (identifiers.length > 0) {
        identifiers.map((id) => {
            list.push(id.did)
        })
    }
    res.send(list);
});



// Define a route that returns a did document from the wallet
app.get('/get_did_doc', async (req: Request, res: Response) => {
    let gotstring:string = <string>req.query.did
    const identifier = await agent.didManagerGet({ did: gotstring })
    console.log('identifier'+identifier)

    res.send(identifier);
});


// Define a route that returns a did document from the wallet
app.get('/get_did_doc', async (req: Request, res: Response) => {
    let gotstring:string = <string>req.query.did
    const identifier = await agent.didManagerGet({ did: gotstring })
    console.log('identifier'+identifier)

    res.send(identifier);
});



// Define a route that returns a did document from the wallet
app.get('/issue_verifiable_credential', async (req: Request, res: Response) => {
    let issuer_did:string = <string>req.query.issuer
    let holder_did:string=<string>req.query.holder
    const attributes: JSON = JSON.parse(<string>req.query.attributes);
    const toStore: boolean | undefined = req.query.store === 'true';
    let credential_subject_full= { ...{id:holder_did}, ...attributes };

    try {
        let verifiableCredential = await agent.createVerifiableCredential({
            credential: {
                "@context": [
                    "https://www.w3.org/2018/credentials/v1",
                    "https://www.w3.org/2018/credentials/examples/v1"
                ],
                issuer: {id: issuer_did},
                credentialSubject: credential_subject_full,
            },
            proofFormat: 'jwt',
            fetchRemoteContexts: true
        })
        if(toStore){
            const hash = await agent.dataStoreSaveVerifiableCredential({ verifiableCredential })
            console.log("stored: "+hash)
        }
        res.send(verifiableCredential);
    } catch (error){
        // we'll proceed, but let's report it
        res.status(500).send({
            message: `credential issuer must be a DID managed by this agent`
        });

    }
});


// Define a route that returns a list of verifiable credentials from wallet
app.get('/list_verifiable_credentials', async (req: Request, res: Response) => {
    const respose = await agent.dataStoreORMGetVerifiableCredentials()
    res.send(respose);
});

// Define a route that returns a qr-code for a verifiable credential
app.get('/get_qr_code', async (req: Request, res: Response) => {
    let hash:string = <string>req.query.hash
    const loaded_credential = await agent.dataStoreGetVerifiableCredential({  hash:hash })
    console.log(loaded_credential.proof['jwt'])

    qrcode.toFile('./filename.png', (loaded_credential.proof['jwt']), {
        color: {
            dark: '#000000',  // Blue dots
            light: '#ffffff' // White background
        }
    }, function (err) {
        if (err) throw err
        console.log('done')
    })


    // reading of qr code from file and obtain the jwt
    // code obtained from https://stackoverflow.com/questions/51948472/image-base64-string-to-uint8clampedarray
    // mixed with https://github.com/pngjs/pngjs/blob/c565210c602527eb459f857eeb78183997482d5b/README.md?plain=1#L258
    let data = fs.readFileSync('filename.png');



    const png = PNG.sync.read(data);
    const code = decode(Uint8ClampedArray.from(png.data), png.width, png.height);
    let code_jwt:string= <string>code?.data
    //remove initial and final " as the string seems double stringified
    if (code_jwt.startsWith('"') && code_jwt.endsWith('"')) {
        code_jwt = code_jwt.substring(1, code_jwt.length - 1);
    }

    //var rawImageData = jpeg.decode(jpegData);
//It follows an alternative way to decode a png, It seems to work but I have no source for it
// Read the PNG image file
    /*
        fs.createReadStream('filename.png')
            .pipe(new PNG())
            .on('parsed', function () {
                // Convert the image data into a Uint8Array
                const imageData = new Uint8ClampedArray(this.width * this.height * 4);
                for (let y = 0; y < this.height; y++) {
                    for (let x = 0; x < this.width; x++) {
                        const idx = (this.width * y + x) << 2;
                        imageData[idx] = this.data[idx];
                        imageData[idx + 1] = this.data[idx + 1];
                        imageData[idx + 2] = this.data[idx + 2];
                        imageData[idx + 3] = this.data[idx + 3];
                    }
                }

                // Use jsQR to decode the QR code
                const code = decode(imageData, this.width, this.height);
                if (code) {
                    console.log('Decoded QR code:', code.data);
                } else {
                    console.log('No QR code found in the image.');
                }
            });    });

     */
    let decoded_jwt=jwtDecode(code_jwt)
    res.send({encoded_jwt:code_jwt,decoded_jwt:decoded_jwt,origin:format_jwt_decoded(code_jwt,decoded_jwt)})
});


function convertTimestampToIssuanceDate(timestampInSeconds: number): string {
    // Ensure timestamp is a valid number
    if (isNaN(timestampInSeconds) || !isFinite(timestampInSeconds)) {
        throw new Error("Invalid timestamp");
    }

    // Convert Unix timestamp to milliseconds
    const milliseconds = timestampInSeconds * 1000;

    // Create a new Date object from the milliseconds
    const date = new Date(milliseconds);

    // Format the date as YYYY-MM-DDTHH:mm:ss.000Z
    return date.toISOString();
}

function format_jwt_decoded(jwt_encoded: string, jwt_decoded: any): string {
    // Create an empty object
    let obj: any = {};
    let credSubj: any = {};
    let proofObj: any = {};
    let issuerObj: any ={};

    // Example usage
    const issuanceDate = convertTimestampToIssuanceDate(jwt_decoded.nbf);
     console.log("Issuance Date:", issuanceDate);

    obj["issuanceDate"] = issuanceDate;

    obj["@context"] = jwt_decoded.vc["@context"];
    console.log("contestoo"+jwt_decoded.vc.context+"\n\n")
    console.log("obj[\"@context\"] ="+obj["@context"]+"\n\n")

    obj.type = jwt_decoded.vc.type;

    credSubj = jwt_decoded.vc.credentialSubject;
    credSubj.id = jwt_decoded.sub;
    obj.credentialSubject = credSubj;


    issuerObj.id = jwt_decoded.sub
    obj.issuer = issuerObj

    proofObj.type = "JwtProof2020";
    proofObj.jwt = jwt_encoded;

    obj.proof = proofObj;

    return (obj);
}

//verify_credential
// Define a route that returns a qr-code for a verifiable credential
app.get('/verify', async (req: Request, res: Response) => {

    const credential = <string>req.query.credential
    /*
    let credenziale = {
        "VerifiableCredential": {
            "credentialSubject": {
                "hi": "hello",
                "id": "did:ethr:goerli:0x034e4ecfb60a1a922c027c356480eab896c21f9eb95feabdb6e8408492c81c3f84"
            },
            "issuer": {
                "id": "did:ethr:goerli:0x034e4ecfb60a1a922c027c356480eab896c21f9eb95feabdb6e8408492c81c3f84"
            },
            "type": [
                "VerifiableCredential"
            ],
            "@context": [
                "https://www.w3.org/2018/credentials/v1",
                "https://www.w3.org/2018/credentials/examples/v1"
            ],
            "issuanceDate": "2024-04-30T14:34:42.000Z",
            "proof": {
                "type": "JwtProof2020",
                "jwt": "eyJhbGciOiJFUzI1NksiLCJ0eXAiOiJKV1QifQ.eyJ2YyI6eyJAY29udGV4dCI6WyJodHRwczovL3d3dy53My5vcmcvMjAxOC9jcmVkZW50aWFscy92MSIsImh0dHBzOi8vd3d3LnczLm9yZy8yMDE4L2NyZWRlbnRpYWxzL2V4YW1wbGVzL3YxIl0sInR5cGUiOlsiVmVyaWZpYWJsZUNyZWRlbnRpYWwiXSwiY3JlZGVudGlhbFN1YmplY3QiOnsiaGkiOiJoZWxsbyJ9fSwic3ViIjoiZGlkOmV0aHI6Z29lcmxpOjB4MDM0ZTRlY2ZiNjBhMWE5MjJjMDI3YzM1NjQ4MGVhYjg5NmMyMWY5ZWI5NWZlYWJkYjZlODQwODQ5MmM4MWMzZjg0IiwibmJmIjoxNzE0NDg3NjgyLCJpc3MiOiJkaWQ6ZXRocjpnb2VybGk6MHgwMzRlNGVjZmI2MGExYTkyMmMwMjdjMzU2NDgwZWFiODk2YzIxZjllYjk1ZmVhYmRiNmU4NDA4NDkyYzgxYzNmODQifQ.7wjtECVeVQYlH9qKko8W98VCxKxIDp3ySrPBXv9b21ou_gbN_xYAQQVldDlZS4iZsWJvKeSqklQbR_IdGcNpQA"
            }
        }
    }*/
    /*
    const loaded_credential = await agent.dataStoreGetVerifiableCredential({ hash: 'QmQYJWqmf672SxbGoCYVwBdwmB1f2dn5nLL4X3ZCHxaY1H' })

    console.log(loaded_credential)
    let special_cred ={
        "issuanceDate": "2024-04-30T21:31:29.000Z",
        "@context": [
            "https://www.w3.org/2018/credentials/v1",
            "https://www.w3.org/2018/credentials/examples/v1"
        ],
        "type": [
            "VerifiableCredential"
        ],
        "credentialSubject": {
            "hi": "hello",
            "id": "did:ethr:sepolia:0x03a29a90b56b9b40d5ef2720149bac4ef812878b52c86ac0da20a40c2383e826c7"
        },
        "issuer": {
            "id": "did:ethr:sepolia:0x03a29a90b56b9b40d5ef2720149bac4ef812878b52c86ac0da20a40c2383e826c7"
        },
        "proof": {
            "type": "JwtProof2020",
            "jwt": "eyJhbGciOiJFUzI1NksiLCJ0eXAiOiJKV1QifQ.eyJ2YyI6eyJAY29udGV4dCI6WyJodHRwczovL3d3dy53My5vcmcvMjAxOC9jcmVkZW50aWFscy92MSIsImh0dHBzOi8vd3d3LnczLm9yZy8yMDE4L2NyZWRlbnRpYWxzL2V4YW1wbGVzL3YxIl0sInR5cGUiOlsiVmVyaWZpYWJsZUNyZWRlbnRpYWwiXSwiY3JlZGVudGlhbFN1YmplY3QiOnsiaGkiOiJoZWxsbyJ9fSwic3ViIjoiZGlkOmV0aHI6c2Vwb2xpYToweDAzYTI5YTkwYjU2YjliNDBkNWVmMjcyMDE0OWJhYzRlZjgxMjg3OGI1MmM4NmFjMGRhMjBhNDBjMjM4M2U4MjZjNyIsIm5iZiI6MTcxNDUxMjY4OSwiaXNzIjoiZGlkOmV0aHI6c2Vwb2xpYToweDAzYTI5YTkwYjU2YjliNDBkNWVmMjcyMDE0OWJhYzRlZjgxMjg3OGI1MmM4NmFjMGRhMjBhNDBjMjM4M2U4MjZjNyJ9.TyURe7YlvHsljsf1VIL7u1ky5NoU-yapCtFsc_jgQqomDwt1JjuWQPQbUn-pMJLoo7IA4Zg3r3-WnnXXrDN8aA"
        }
    }
    console.log("\n\n")
    console.log(loaded_credential)

    console.log("\n\n")

    console.log(special_cred)
    console.log("\n\n")
    const result = await agent.verifyCredential({
        credential: loaded_credential
    })
    console.log(`Credential verified res`,     result.verified
    )

    console.log(`Credential verified err`,     result.error
    )*/
    const result = await agent.verifyCredential({
        credential: credential
    })

    res.send(result)
});


// Listen on port 3000
app.listen(3000, () => {
    console.log('Server is running on port 3000');
});
