    // Import Express
    import express, {Request, response, Response} from 'express';
    import { performance } from 'universal-perf-hooks'

    import cors from 'cors';
    // Import axios
    import qrcode from 'qrcode'
    import { agent } from "./src/veramo/setup.js"
    import { agentETH } from "./src/veramo/setupETH.js"
    
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
        PresentationPayload,
        CredentialPayload,
        IssuerType,
        TPresentationColumns,
        W3CVerifiablePresentation,
        MinimalImportableKey
    } from "@veramo/core";
    
    import {ICredentialIssuerLD} from "@veramo/credential-ld"
    import fs from 'fs'
    import  decode from 'jsqr'
    // Create an app instance
    import {PNG} from 'pngjs'
    import jpeg from 'jpeg-js'
    import { jwtDecode } from "jwt-decode";
    import bodyParser from "body-parser"
    import {Presentation} from "@veramo/data-store";
    const app = express();
    
    // Enable CORS
    app.use(cors());
    app.use(bodyParser.json());
    
    
    
    // Endpoint to get DID ETHR by private key
    app.get("/api/v0/check/", async (req: Request, res: Response) => {
        const walletAddr: string = <string>req.query.walletaddr;
        try {
            console.log(`Checking DID for wallet address: ${walletAddr}`);
            const identifier = await agentETH.didManagerGetByAlias({ alias: walletAddr });
            console.log(`Identifier found: ${JSON.stringify(identifier)}`);
            res.send(identifier);
        } catch (error) {
            console.error(`Error retrieving DID for wallet address ${walletAddr}:`, error);
            res.send({ result: 'null' });
        }
    });
    
    // Endpoint to get DID ETHR by private key
    app.get("/api/v0/setup/", async (req: Request, res: Response) => {
        const privateKey: string = <string>req.query.privatekey;
        const walletAddr: string = <string>req.query.walletaddr;
    
        try {
            console.log(`Setting up DID for wallet address: ${walletAddr} with private key: ${privateKey}`);
            let identifier = await agentETH.didManagerGetByAlias({ alias: walletAddr });
            console.log(`Identifier found: ${JSON.stringify(identifier)}`);
            res.send(identifier);
            return;
        } catch (error) {
            console.warn(`DID not found for wallet address ${walletAddr}, proceeding to import. Error:`, error);
        }
    
        // If identifier not found, then import it
        try {
            const identifier = await agentETH.didManagerImport({
                did: "did:ethr:" + walletAddr,
                alias: walletAddr,
                provider: "did:ethr",
                keys: [
                    {
                        type: "Secp256k1",
                        kms: "local",
                        kid: "key-1" + walletAddr,
                        privateKeyHex: privateKey,
                    } as MinimalImportableKey,
                ],
                services: [],
            });
            console.log(`Identifier created: ${JSON.stringify(identifier)}`);
            res.send(identifier);
        } catch (error) {
            console.error(`Error creating identifier for wallet address ${walletAddr}:`, error);
            res.status(500).send({ error: 'An error occurred while creating the identifier.' });
        }
    });
    
    app.get("/api/v0/confirm/", async (req: Request, res: Response) => {
        let privateKey: string = <string>req.query.privatekey;
    
        let walletAddr: string = <string>req.query.walletaddr;
    
        let identifier;
        // Use the private key directly without converting it
        console.log(privateKey + " "+ walletAddr)
        try{
            identifier = await agentETH.didManagerGetByAlias({alias: walletAddr});
            console.log(identifier)
    
        }catch (error){
            console.log(error)
    
        }
        if(identifier){
            console.log(identifier);
            res.send(identifier);
            return;
        }
    
        try {
            identifier = await agentETH.didManagerImport({
                did: "did:ethr:" + walletAddr,
                alias: walletAddr,
                provider: "did:ethr",
                keys: [
                    {
                        "type": "Secp256k1",
                        "kms": "local",
                        "kid": "key-1"+walletAddr,
                        privateKeyHex: privateKey
                    } as MinimalImportableKey,
                ],
                services: []
            });
            console.log(identifier);
            res.send(identifier);
        } catch (error) {
            console.error(error);
            res.status(500).send({ error: 'An error occurred while creating the identifier.' });
        }
    });
    
    app.get("/create_did_by_alias", async (req: Request, res: Response) => {
        let gotalias:string = <string>req.query.alias
    
        const identifier = await agent.didManagerCreate({ alias: gotalias })
        res.send(identifier);
    });
    
    app.get("/create_did", async (req: Request, res: Response) => {
        const identifier = await agent.didManagerCreate({})
        res.send(identifier);
    });
    
    
    
    // Define a route that returns a list of dids from the wallet
    app.get('/get_own_did', async (req: Request, res: Response) => {
        const identifiers = await agent.didManagerFind()
        const identifiersETHR = await agentETH.didManagerFind()
    
        console.log(`There are ${identifiers.length} identifiers`)
    
        let list: string[] = []
    
    
        if (identifiers.length > 0) {
            identifiers.map((id) => {
                list.push(id.did)
            })
        }
        if (identifiersETHR.length > 0){
            identifiersETHR.map((id) => {
                list.push(id.did)
            })
        }
        res.send({"dids":list});
    });
    
    // Define a route that returns a list of dids from the wallet
    app.get('/get_own_did_eth', async (req: Request, res: Response) => {
        const identifiers = await agentETH.didManagerFind()
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
        let gotstring: string = <string>req.query.did;
    
        // Choose the appropriate agent based on the presence of ":sepolia" in the did
        const agentToUse = !gotstring.includes(':sepolia') ? agentETH : agent;
    
        try {
            const identifier = await agentToUse.didManagerGet({ did: gotstring });
            console.log('identifier', identifier);
    
            res.send(identifier);
        } catch (error) {
            console.error('Error fetching DID document:', error);
            res.status(500).send({ error: 'Failed to fetch DID document' });
        }
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
    
    // Define the route to store a verifiable credential
    app.post('/store_vc', bodyParser.json(), async (req: Request, res: Response) => {
        try {
            console.log("here");
            console.log(req.body); // This should work
            // Log the keys of the JSON object
            const did = req.body.did;
    
            // Choose the appropriate agent based on the presence of "sepolia" in the did
            const agentToUse = !did.includes('sepolia') ? agentETH : agent;
    
            const decoded_jwt: VerifiableCredentialDecoded = jwtDecode(req.body.verifiableCredential);
            const verifiable_credential = format_jwt_decoded_to_VC(req.body.verifiableCredential, decoded_jwt) as VerifiableCredential;
    
            try {
                console.log(req.body.verifiableCredential);
                console.log(req.body.credentialSubject);
    
                let vc: IDataStoreSaveVerifiableCredentialArgs = ({ verifiableCredential: verifiable_credential }) as IDataStoreSaveVerifiableCredentialArgs;
                console.log("here is vc" + JSON.stringify(vc));
    
                // Use the selected agent to save the verifiable credential
                const hash = await agentToUse.dataStoreSaveVerifiableCredential(vc);
                res.send({ res: "OK", hash: hash });
    
            } catch (error) {
                console.log(error);
                // We'll proceed, but let's report it
                res.status(500).send({
                    message: `error in store`
                });
            }
    
        } catch (error) {
            console.log(error);
            // Handle errors
            res.status(500).send({
                message: `error in processing`
            });
        }
    });

    // Internal function to issue a verifiable credential
    async function issueCredential(
        issuer_did: string,
        holder_did: string,
        type_cred: string,
        attributes: JSON,
        toStore: boolean
    ) {
        let credential_subject_full = { ...{ id: holder_did }, ...attributes };
        let typeToPut: string[] = [];

        if (type_cred) {
            typeToPut.push(type_cred);
        }

        // Choose the appropriate agent based on the presence of "sepolia" in the issuer_did
        const agentToUse = !issuer_did.includes(':sepolia') ? agentETH : agent;

        // Create the verifiable credential
        let verifiableCredential = await agentToUse.createVerifiableCredential({
            credential: {
                "@context": ["https://www.w3.org/ns/credentials/v2"],
                issuer: { id: issuer_did },
                type: typeToPut,
                credentialSubject: credential_subject_full,
            },
            proofFormat: 'jwt',
            fetchRemoteContexts: true
        });

        // Optionally store the credential
        if (toStore) {
            const hash = await agentToUse.dataStoreSaveVerifiableCredential({ verifiableCredential });
            console.log("Stored credential with hash: " + hash);
        }

        return verifiableCredential.proof.jwt; // Return the JWT of the credential
    }

    // Route without measuring execution time
    app.post('/issue_verifiable_credential', async (req: Request, res: Response) => {
        let issuer_did: string = <string>req.body.issuer;
        let holder_did: string = <string>req.body.holder;
        let type_cred: string = <string>req.body.type;
        const attributes: JSON = req.body.attributes;
        const toStore: boolean = req.body.store === true;

        try {
            const jwt = await issueCredential(issuer_did, holder_did, type_cred, attributes, toStore);
            res.send({ res: "OK", jwt });
        } catch (error) {
            console.log(error);
            res.status(500).send({ message: `Credential issuer must be a DID managed by this agent` });
        }
    });

    // Test route that measures execution time
    app.post('/test_issue_verifiable_credential', async (req: Request, res: Response) => {
        let issuer_did: string = <string>req.body.issuer;
        let holder_did: string = <string>req.body.holder;
        let type_cred: string = <string>req.body.type;
        const attributes: JSON = req.body.attributes;
        const toStore: boolean = req.body.store === true;
        const numTrials: number = req.body.numTrials || 1; // Number of trials, default is 1

        let times: number[] = [];

        for (let i = 0; i < numTrials; i++) {
            const start = performance.now();
            try {
                await issueCredential(issuer_did, holder_did, type_cred, attributes, toStore);
            } catch (error) {
                console.log(error);
                res.status(500).send({ message: `Credential issuer must be a DID managed by this agent` });
                return;
            }
            const end = performance.now();
            times.push(end - start);
        }

        // Calculate mean and standard deviation
        const mean = times.reduce((a, b) => a + b, 0) / numTrials;
        const variance = times.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / numTrials;
        const stdev = Math.sqrt(variance);

        res.send({ mean, stdev });
    });


    // Internal function to issue a verifiable presentation for holder claim
    async function issueHolderClaimPresentation(
        holderDid: string,
        typeCred: string,
        attributes: JSON,
        assertion: string,
        toStore: boolean
    ) {
        // Choose the appropriate agent based on the presence of "sepolia" in the holderDid
        const agentToUse = !holderDid.includes('sepolia') ? agentETH : agent;

        // Create verifiable presentation
        const verifiablePresentation = await createVPwithHolderClaim(typeCred, assertion, holderDid, attributes);

        if (verifiablePresentation) {
            // Optionally store the verifiable presentation
            if (toStore) {
                const hash = await agentToUse.dataStoreSaveVerifiablePresentation({ verifiablePresentation });
                console.log("Stored verifiable presentation with hash: " + hash);
            }
            return verifiablePresentation.proof.jwt; // Return the JWT of the presentation
        } else {
            throw new Error("Failed to create verifiable presentation");
        }
    }

    // Route without measuring execution time
    app.post('/issue_verifiable_presentation/holder_claim', async (req: Request, res: Response) => {
        const holderDid: string = req.body.holder;
        const typeCred: string = req.body.type;
        const attributes: JSON = req.body.attributes;
        const assertion: string = req.body.assertion;
        const toStore: boolean = req.body.store === true;

        try {
            const jwt = await issueHolderClaimPresentation(holderDid, typeCred, attributes, assertion, toStore);
            res.send({ res: "OK", jwt });
        } catch (error) {
            console.error(error);
            res.status(500).send({ message: "Internal server error" });
        }
    });

    // Test route that measures execution time
    app.post('/test_issue_verifiable_presentation/holder_claim', async (req: Request, res: Response) => {
        const holderDid: string = req.body.holder;
        const typeCred: string = req.body.type;
        const attributes: JSON = req.body.attributes;
        const assertion: string = req.body.assertion;
        const toStore: boolean = req.body.store === true;
        const numTrials: number = req.body.numTrials || 1; // Number of trials, default is 1

        let times: number[] = [];

        for (let i = 0; i < numTrials; i++) {
            const start = performance.now();
            try {
                await issueHolderClaimPresentation(holderDid, typeCred, attributes, assertion, toStore);
            } catch (error) {
                console.error(error);
                res.status(500).send({ message: "Internal server error" });
                return;
            }
            const end = performance.now();
            times.push(end - start); // store the execution time
        }

        // Calculate mean and standard deviation
        const mean = times.reduce((a, b) => a + b, 0) / numTrials;
        const variance = times.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / numTrials;
        const stdev = Math.sqrt(variance);

        res.send({ mean, stdev });
    });


    
    
    // Define a route that returns a list of verifiable presentations from the wallet
    app.get('/list_verifiable_presentations', async (req: Request, res: Response) => {
        try {
            // Retrieve the list of verifiable presentations from the wallet
            const verifiablePresentations = await agent.dataStoreORMGetVerifiablePresentations();
            verifiablePresentations.concat(await agentETH.dataStoreORMGetVerifiablePresentations())
            // Send the list of verifiable presentations as the response
            res.send(verifiablePresentations);
        } catch (error) {
            // If an error occurs, send an error response
            console.error(error);
            res.status(500).send({ message: "Internal server error" });
        }
    });
    
    
    // Define a route that returns a list of verifiable credentials from wallet
    app.get('/api/v0/list-verifiable-credentials-with-type', async (req: Request, res: Response) => {
        console.log("received request to get verifiable credentials with type")
        let queryParam = <string>req.query.type
        const query: FindArgs<TCredentialColumns> = {
            where: [
                {
                    column: 'type',
                    value: ['VerifiableCredential,'+queryParam],
                    op: 'Equal',}
            ],
            order: [{ column: 'issuanceDate', direction: 'ASC' }],
        }
    
    
        // Fetch results from both data stores
        let response1 = await agent.dataStoreORMGetVerifiableCredentials(query);
        let response2 = await agentETH.dataStoreORMGetVerifiableCredentials(query);
    
        // Concatenate the results
        let concatenatedResponse = response1.concat(response2);
        console.log("respon"+concatenatedResponse.toString())
    
        res.send(concatenatedResponse);
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
            // Fetch results from both data stores
            let response1 = await agent.dataStoreORMGetVerifiablePresentations(query);
            let response2 = await agentETH.dataStoreORMGetVerifiablePresentations(query);
    
            // Concatenate the results
            let concatenatedResponse = response1.concat(response2);
            console.log("response"+concatenatedResponse.toString())
    
            res.send(concatenatedResponse);
        } catch (error) {
            // If an error occurs, send an error response
            console.error(error);
            res.status(500).send({ message: "Internal server error" });
        }
    });
    
    
    // Define a route that returns ONE verifiable credentials from wallet given an HASH
    app.get('/get_verifiable_credential', async (req: Request, res: Response) => {
        let hash:string = <string>req.query.hash_cred
        let respose = await agent.dataStoreGetVerifiableCredential({hash})
        if(!respose){
            //if not in the agent connected to sepolia, find it in the ETH sepolia agent
            respose = await agentETH.dataStoreGetVerifiableCredential({hash})
        }
    
        res.send(respose);
    });
    
    
    
    //route to get a verifiable presentation from qr code
    app.post('/decode_jwt/image', async (req: Request, res: Response) => {
        let png_data = req.body.img_data
    
        const buffer:Buffer = Buffer.from(png_data,'base64')
        console.log(buffer.length+"len of buf\n")
        const png = PNG.sync.read(buffer);
    
        const code = decode(Uint8ClampedArray.from(png.data), png.width, png.height);
        console.log("after code decode")
        let code_jwt: string = <string>code?.data
        //remove initial and final " as the string seems double stringified
        if (code_jwt.startsWith('"') && code_jwt.endsWith('"')) {
            code_jwt = code_jwt.substring(1, code_jwt.length - 1);
        }
    
    
        let decoded = jwtDecode(code_jwt);
        let result = decoded; //result can be any json if not in the following two categories
        if(decoded.hasOwnProperty('vc')){
            //if a veriable credential
            let result:VerifiableCredential = format_jwt_decoded_to_VC(code_jwt,decoded)
            res.send(result);
            return;
        }
        else if(decoded.hasOwnProperty('vp')){
            let result:VerifiablePresentation = format_jwt_decoded_to_VP(code_jwt,decoded)
    
            res.send(result);
    
            return;
        }
        res.send(result);
    });
    
    
    // Define a route that returns a qr-code for a verifiable credential
    app.get('/get_qr_code/wallet_hash', async (req: Request, res: Response) => {
    
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
    
            console.log("this is png "+png)
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
    
    // Define a route that returns a qr-code for a verifiable credential
    app.post('/get_qr_code/jwt', async (req: Request, res: Response) => {
        let jwt: string = <string>req.body.jwt;
        try {
            qrcode.toFile('./filename.png', jwt, {
                color: {
                    dark: '#000000',  // Blue dots
                    light: '#ffffff' // White background
                }
            }, async function (err) {
                if (err) {
                    throw err;
                } else {
                    try {
                        // Wait for the file to be written before reading it
                        let data = await fs.promises.readFile('./filename.png');
                        console.log(data);
                        res.setHeader('Content-Type', 'image/png');
                        res.send(data);
                    } catch (error) {
                        console.error('Error reading QR code file:', error);
                        res.status(500).send({
                            message: 'Error reading QR code file'
                        });
                    }
                }
            });
        } catch (error) {
            console.error('Error generating QR code:', error);
            res.status(500).send({
                message: 'Error generating QR code'
            });
        }
    });
    
    
    //route to convert a jwt to VP or VC (or any other text)
    app.get("/decode_jwt", async (req: Request, res: Response) => {
        let jwt:string = <string>req.query.jwt
        try {
        let decoded = jwtDecode(jwt);
        let result = decoded; //result can be any json if not in the following two categories
            if (decoded.hasOwnProperty('vc')) {
                //if a veriable credential
                let result: VerifiableCredential = format_jwt_decoded_to_VC(jwt, decoded)
                res.send(result);
                return;
            } else if (decoded.hasOwnProperty('vp')) {
                let result: VerifiablePresentation = format_jwt_decoded_to_VP(jwt, decoded)
    
                res.send(result);
    
                return;
            }
        } catch (error){
            res.status(500).send("error decoding");
    
        }
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
    
    function format_jwt_decoded_to_VC(jwt_encoded: string, jwt_decoded: any): VerifiableCredential {
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
    
    
        issuerObj.id = jwt_decoded.iss
        obj.issuer = issuerObj
    
        proofObj.type = "JwtProof2020";
        proofObj.jwt = jwt_encoded;
    
        obj.proof = proofObj;
    
        return (obj);
    }
    
    function format_jwt_decoded_to_VP(jwt_encoded: string, jwt_decoded: any): VerifiablePresentation {
        // Create an empty object
        let obj: any = {};
        let credentials: any = {};
        let proofObj: any = {};
    
    
        console.log("the keys of deconded"+jwt_decoded.keys)
        // Example usage
        console.log("date is"+jwt_decoded.nbf)
        const issuanceDate = convertTimestampToIssuanceDate(jwt_decoded.nbf);
        console.log("Issuance Date:", issuanceDate);
    
        obj["issuanceDate"] = issuanceDate;
    
        obj["@context"] = jwt_decoded.vp["@context"];
    
    
        obj.type = jwt_decoded.vp.type;
        obj.holder = jwt_decoded.iss //iss corresponds to the holder, the one creating the vp
        obj.id = jwt_decoded.jti;//jti corresponds to the id (Which can be a uuid) assigned to the claim
    
    
        credentials = jwt_decoded.vp.verifiableCredential;
        let jwt_cred;
        for (let i = 0; i < credentials.length; i++) {
            if(!credentials[i].hasOwnProperty('vc')){ // if already decoded vc, keep as it is
                //if not then it is encoded as jwt, we decode and assign
                jwt_cred = jwtDecode(credentials[i]);
                credentials[i] = format_jwt_decoded_to_VC(credentials[i],jwt_cred); // assign decoded jwt
            }
        }
        obj.verifiableCredential=credentials
    
        proofObj.type = "JwtProof2020";
        proofObj.jwt = jwt_encoded;
    
        obj.proof = proofObj;
    
        return (obj);
    }
    
    //TODO VERIFY SHOULD BE FROM DID:ETHR AGENT
    
        async function createVPwithHolderClaim(typeVP: string, assertion:string,holder: string, jsonVar: JSON): Promise<VerifiablePresentation|null> {
            let presentationPayload: PresentationPayload = {} as PresentationPayload;
    
    
            presentationPayload.type = ["VerifiablePresentation", typeVP]
            presentationPayload["@context"] = ["https://www.w3.org/ns/credentials/v2"]
            presentationPayload.holder = holder
    
            const agentToUse = !holder.includes('sepolia') ? agentETH : agent;
    
    
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
                let verifiableCredential = await agentToUse.createVerifiableCredential({
                    credential:vc_payload,
                    proofFormat: 'jwt',
                    fetchRemoteContexts: true
                })
    
                presentationPayload.verifiableCredential = [verifiableCredential]
    
    
                let verifiablePresentation = await agentToUse.createVerifiablePresentation({
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
    app.post('/verify', async (req: Request, res: Response) => {
    
        const credential = <VerifiableCredential>req.body.credential
        // Choose the appropriate agent based on the presence of "sepolia" in the holderDid
        const agentToUse = !req.body.credential.issuer.id.includes(':sepolia') ? agentETH : agent;
        const result:IVerifyResult = await agentToUse.verifyCredential({
            credential: credential
        })
    
        console.log("result of verification"+result.verified)
        res.send({res:result.verified})
    });
    
    //verify_presentation
    app.post('/verify/vp', async (req: Request, res: Response) => {
    
        const vp:W3CVerifiablePresentation = <W3CVerifiablePresentation>req.body.vp
        const did = req.body.vp.holder
        const result = await (verifyPresentation(vp,did))
    
        res.send({res:result.verified})
    });
    
     async function verifyPresentation(VP:W3CVerifiablePresentation,did:string): Promise<IVerifyResult> {
         //simple verification call, you need to provide the internal content of VerifiablePresentation:
         const agentToUse = !did.includes(':sepolia') ? agentETH : agent;
         let ris:IVerifyResult = await agentToUse.verifyPresentation({ presentation: VP });
        return ris;
    }
    //test for X trials of verification of VC
    app.post('/test_verify', async (req: Request, res: Response) => {
        const credential = <VerifiableCredential>req.body.credential;
        const numTrials = req.body.numTrials || 1; // Number of trials from the request, default is 1

        const agentToUse = !req.body.credential.issuer.id.includes(':sepolia') ? agentETH : agent;

        let times: number[] = [];

        for (let i = 0; i < numTrials; i++) {
            const start = performance.now();

            const result: IVerifyResult = await agentToUse.verifyCredential({
                credential: credential
            });

            const end = performance.now();
            times.push(end - start); // store the execution time
        }

        const mean = times.reduce((a, b) => a + b, 0) / numTrials;
        const variance = times.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / numTrials;
        const stdev = Math.sqrt(variance);

        console.log(`Result of verification: ${mean}, Stdev: ${stdev}`);
        res.send({ mean, stdev });
    });

    //test for X trials of verification of VP
    app.post('/test_verify/vp', async (req: Request, res: Response) => {
        const vp: W3CVerifiablePresentation = <W3CVerifiablePresentation>req.body.vp;
        const did = req.body.vp.holder;
        const numTrials = req.body.numTrials || 1; // Number of trials from the request, default is 1

        let times: number[] = [];

        for (let i = 0; i < numTrials; i++) {
            const start = performance.now();

            const result = await verifyPresentation(vp, did);

            const end = performance.now();
            times.push(end - start); // store the execution time
        }

        const mean = times.reduce((a, b) => a + b, 0) / numTrials;
        const variance = times.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / numTrials;
        const stdev = Math.sqrt(variance);

        res.send({ mean, stdev });
    });




    // Listen on port 3001
    app.listen(3001, () => {
        console.log('Server is running on port 3001');
    });
