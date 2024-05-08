// Import Express
import express, { Request, Response } from 'express';
import cors from 'cors';
// Import axios
import axios from 'axios';
import qrcode from 'qrcode'
import { agent } from './src/veramo/setup.js'
import {
    CredentialSubject,
    ICredentialIssuer,
    IDataStoreSaveVerifiableCredentialArgs,
    IDIDManagerGetArgs,
    IIdentifier,
    VerifiableCredential,
    FindArgs,
    TCredentialColumns,
    Where,
    IVerifyResult,
    VerifiablePresentation,
    PresentationPayload, CredentialPayload, IssuerType, TPresentationColumns
} from "@veramo/core";
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
import bodyParser from "body-parser"
import {Presentation} from "@veramo/data-store";
const app = express();

// Enable CORS
app.use(cors());
app.use(bodyParser.json());

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
    res.send({"dids":list});
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


function parseNestedJSON(obj: any): any {
    let parsed: any = {};
    // Iterate over all keys in the object
    for (let key in obj) {
        // Check if the value corresponding to the key is an object
        if (typeof obj[key] === 'object' && obj[key] !== null) {
            // If it's an object, recursively parse it and assign the result to the key
            parsed[key] = parseNestedJSON(obj[key]);
        } else if (typeof obj[key] === 'string') {
            // If it's a string, try to parse it as JSON
            try {
                // Attempt to parse as JSON object
                parsed[key] = JSON.parse(obj[key]);
            } catch (error) {
                // If parsing as object fails, attempt to parse as JSON array
                try {
                    // Attempt to parse as JSON array
                    parsed[key] = JSON.parse(`[${obj[key]}]`);
                } catch (error) {
                    // If parsing fails, assign the string value as is
                    parsed[key] = obj[key];
                }
            }
        } else {
            // If it's not an object or a string, assign its value to the key
            parsed[key] = obj[key];
        }
    }
    return parsed;
}
// Define an interface representing the structure of your JSON object
interface VerifiableCredentialDecoded {
    vc: any; // Define the type of vc accordingly
    sub: string;
    nbf: number;
    iss: string;
}
// Define an interface representing the structure of your JSON object
interface VerifiableCredentialDecoded {
    vc: any; // Define the type of vc accordingly
    sub: string;
    nbf: number;
    iss: string;
}

// Your route handler
app.post('/store_vc', bodyParser.json(), async (req: Request, res: Response) => {
    try {
        console.log("here");
        console.log(req.body.verifiableCredential); // This should work
        // Log the keys of the JSON object
        const decoded_jwt:VerifiableCredentialDecoded = jwtDecode(req.body.verifiableCredential)
        const verifiable_credential = format_jwt_decoded(req.body.verifiableCredential,decoded_jwt) as VerifiableCredential
        try{
            console.log(req.body.verifiableCredential)
            console.log(req.body.credentialSubject)

            let vc:IDataStoreSaveVerifiableCredentialArgs = ({verifiableCredential:verifiable_credential}) as IDataStoreSaveVerifiableCredentialArgs
            console.log("here is vc"+JSON.stringify(vc))
            const hash = await agent.dataStoreSaveVerifiableCredential(vc);
            res.send({res:"OK",hash: hash});

        } catch (error){
            console.log(error)
            // we'll proceed, but let's report it
            res.status(500).send({
                message: `error in store`
            });

        }

    } catch (error) {
        console.log(error);
        // Handle errors
    }
});

// Define a route that issues a credential
app.post('/issue_verifiable_credential', async (req: Request, res: Response) => {

    console.log(req.body)
    let issuer_did:string = <string>req.body.issuer

    let holder_did:string=<string>req.body.holder
    let type_cred:string=<string>req.body.type

    const attributes: JSON= req.body.attributes
    const toStore: boolean | undefined = req.body.store === true;
    let credential_subject_full= { ...{id:holder_did}, ...attributes };
    let typeToPut:string[] = []
    if(type_cred){
        typeToPut.push(type_cred)
    }

    try {
        let verifiableCredential = await agent.createVerifiableCredential({
            credential: {
                "@context": [
                    "https://www.w3.org/ns/credentials/v2",
                ],
                issuer: {id: issuer_did},
                type:typeToPut,
                credentialSubject: credential_subject_full,
            },
            proofFormat: 'jwt',
            fetchRemoteContexts: true
        })

        if(toStore){
            console.log("before storing"+JSON.stringify(verifiableCredential,null,2))
            const hash = await agent.dataStoreSaveVerifiableCredential({ verifiableCredential })
            console.log("stored: "+hash)
            res.send({res:"OK",jwt: verifiableCredential.proof.jwt});

        }
        else {
            console.log("sending"+verifiableCredential.proof.jwt)
            res.send({res: "OK", jwt: verifiableCredential.proof.jwt});
        }
    } catch (error){
        console.log(error)
        // we'll proceed, but let's report it
        res.status(500).send({
            message: `credential issuer must be a DID managed by this agent`
        });

    }
});


// Define a route that issues a verifiable presentation
app.post('/issue_verifiable_presentation/holder_claim', async (req: Request, res: Response) => {
    const holderDid: string = req.body.holder;
    const typeCred: string = req.body.type;
    const attributes: JSON = req.body.attributes;
    const assertion:string = req.body.assertion;
    const toStore: boolean | undefined = req.body.store === true;

    try {
        const verifiablePresentation = await createVPwithHolderClaim(typeCred, assertion,holderDid, attributes);

        if (verifiablePresentation) {
            if (toStore) {
                const hash = await agent.dataStoreSaveVerifiablePresentation({ verifiablePresentation });
                console.log("Stored: " + hash);
            }
            res.send({ res: "OK", jwt: verifiablePresentation.proof.jwt });
        } else {
            res.status(500).send({ message: "Failed to create verifiable presentation" });
        }
    } catch (error) {
        console.error(error);
        res.status(500).send({ message: "Internal server error" });
    }
});




// Define a route that returns a list of verifiable credentials from wallet
app.get('/list_verifiable_credentials', async (req: Request, res: Response) => {


    const respose = await agent.dataStoreORMGetVerifiableCredentials()
    res.send(respose);
});
// Define a route that returns a list of verifiable presentations from the wallet
app.get('/list_verifiable_presentations', async (req: Request, res: Response) => {
    try {
        // Retrieve the list of verifiable presentations from the wallet
        const verifiablePresentations = await agent.dataStoreORMGetVerifiablePresentations();

        // Send the list of verifiable presentations as the response
        res.send(verifiablePresentations);
    } catch (error) {
        // If an error occurs, send an error response
        console.error(error);
        res.status(500).send({ message: "Internal server error" });
    }
});


// Define a route that returns a list of verifiable credentials from wallet
app.get('/list_verifiable_credentials_with_type', async (req: Request, res: Response) => {

    let queryParam = req.query.type as string
    const query: FindArgs<TCredentialColumns> = {
        where: [
            {
                column: 'type',
                value: ['VerifiableCredential,'+queryParam],
                op: 'Equal',}
        ],
        order: [{ column: 'issuanceDate', direction: 'ASC' }],
    }


    let respose = await agent.dataStoreORMGetVerifiableCredentials(query)

    console.log("respon"+respose.toString())

    res.send(respose);
});

// Define a route that returns a list of verifiable presentations from the wallet based on a specific type
app.get('/list_verifiable_presentations_with_type', async (req: Request, res: Response) => {
    try {
        // Extract the type query parameter from the request
        const queryParam: string = req.query.type as string;

        // Define the query to filter verifiable presentations by type
        const query: FindArgs<TPresentationColumns> = {
            where: [
                {
                    column: 'type',
                    value: ['VerifiablePresentation,'+queryParam],
                    op: 'Equal',
                }
            ],
            order: [{ column: 'issuanceDate', direction: 'ASC' }],
        };

        // Retrieve the list of verifiable presentations from the wallet based on the type query
        const response = await agent.dataStoreORMGetVerifiablePresentations(query);

        // Send the list of verifiable presentations as the response
        res.send(response);
    } catch (error) {
        // If an error occurs, send an error response
        console.error(error);
        res.status(500).send({ message: "Internal server error" });
    }
});


// Define a route that returns ONE verifiable credentials from wallet given an HASH
app.get('/get_verifiable_credential', async (req: Request, res: Response) => {
    let hash:string = <string>req.query.hash_cred
    const respose = await agent.dataStoreGetVerifiableCredential({hash})
    res.send(respose);
});

// Define a route that returns a qr-code for a verifiable credential
app.get('/get_qr_code', async (req: Request, res: Response) => {
    let hash:string = <string>req.query.hash
    let loaded_credential;
    //loaded_credential = await agent.dataStoreGetVerifiableCredential({hash: hash})

    try {
        loaded_credential = await agent.dataStoreGetVerifiableCredential({hash: hash})
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
        let code_jwt: string = <string>code?.data
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
        let decoded_jwt = jwtDecode(code_jwt)

        // Set the appropriate content type in the response headers

        res.setHeader('Content-Type', 'image/png');
        res.send(data);
    }
    catch (Error){
        res.status(500).send({
            message: `Response: unsupported engine}`
    });
}

//res.send({encoded_jwt:code_jwt,decoded_jwt:decoded_jwt,origin:format_jwt_decoded(code_jwt,decoded_jwt)})
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

function format_jwt_decoded(jwt_encoded: string, jwt_decoded: any): VerifiableCredential {
    // Create an empty object
    let obj: any = {};
    let credSubj: any = {};
    let proofObj: any = {};
    let issuerObj: any ={};

    // Example usage
    console.log("date is"+jwt_decoded.nbf)
    const issuanceDate = convertTimestampToIssuanceDate(jwt_decoded.nbf);
    console.log("Issuance Date:", issuanceDate);

    obj["issuanceDate"] = issuanceDate;

    obj["@context"] = jwt_decoded.vc["@context"];
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


    async function createVPwithHolderClaim(typeVP: string, assertion:string,holder: string, jsonVar: JSON): Promise<VerifiablePresentation|null> {

        let presentationPayload: PresentationPayload = {} as PresentationPayload;


        presentationPayload.type = ["VerifiablePresentation", typeVP]
        presentationPayload["@context"] = ["https://www.w3.org/ns/credentials/v2"]
        presentationPayload.holder = holder


        //create a uuid for the VP
        let uuid = crypto.randomUUID()
        presentationPayload.id = uuid;


        let vc_payload: CredentialPayload = {} as CredentialPayload;

        let issuer_data: IssuerType = {id:holder} as IssuerType;
        vc_payload.issuer = issuer_data
        vc_payload["@context"]= ["https://www.w3.org/ns/credentials/v2"]
        vc_payload.type = ['VerifiableCredential', 'VCPresentation',"VCfor"+typeVP]
        let vc_cred_subj: CredentialSubject = jsonVar
        //vc_cred_subj['assertion'] = 'This VP is submitted by the subject as evidence of  VC propagation'
        vc_cred_subj['assertion'] = assertion

        vc_cred_subj['id'] = uuid

        vc_payload.credentialSubject = vc_cred_subj;

        try {
            let verifiableCredential = await agent.createVerifiableCredential({
                credential:vc_payload,
                proofFormat: 'jwt',
                fetchRemoteContexts: true
            })

            presentationPayload.verifiableCredential = [verifiableCredential]


            let verifiablePresentation = await agent.createVerifiablePresentation({
                presentation:presentationPayload,
                proofFormat: 'jwt'
            })

            return verifiablePresentation
        } catch (error) {
            console.log(error)
            return  null
        }
        return null
    }

//verify_credential
// Define a route that returns a qr-code for a verifiable credential
app.post('/verify', async (req: Request, res: Response) => {

    const credential = <VerifiableCredential>req.body.credential
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
    const result:IVerifyResult = await agent.verifyCredential({
        credential: credential
    })

    console.log("result of verification"+result.verified)
    res.send({res:result.verified})
});


// Listen on port 3000
app.listen(3001, () => {
    console.log('Server is running on port 3001');
});
