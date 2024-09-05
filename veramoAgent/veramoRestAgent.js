// Import Express
import express from 'express';
import cors from 'cors';
// Import axios
import qrcode from 'qrcode';
import { agent } from "./src/veramo/setup.js";
import { agentETH } from "./src/veramo/setupETH.js";
import fs from 'fs';
import decode from 'jsqr';
// Create an app instance
import { PNG } from 'pngjs';
import { jwtDecode } from "jwt-decode";
import bodyParser from "body-parser";
const app = express();
// Enable CORS
app.use(cors());
app.use(bodyParser.json());
// Endpoint to get DID ETHR by private key
app.get("/api/v0/check/", async (req, res) => {
    const walletAddr = req.query.walletaddr;
    try {
        console.log(`Checking DID for wallet address: ${walletAddr}`);
        const identifier = await agentETH.didManagerGetByAlias({ alias: walletAddr });
        console.log(`Identifier found: ${JSON.stringify(identifier)}`);
        res.send(identifier);
    }
    catch (error) {
        console.error(`Error retrieving DID for wallet address ${walletAddr}:`, error);
        res.send({ result: 'null' });
    }
});
// Endpoint to get DID ETHR by private key
app.get("/api/v0/setup/", async (req, res) => {
    const privateKey = req.query.privatekey;
    const walletAddr = req.query.walletaddr;
    try {
        console.log(`Setting up DID for wallet address: ${walletAddr} with private key: ${privateKey}`);
        let identifier = await agentETH.didManagerGetByAlias({ alias: walletAddr });
        console.log(`Identifier found: ${JSON.stringify(identifier)}`);
        res.send(identifier);
        return;
    }
    catch (error) {
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
                },
            ],
            services: [],
        });
        console.log(`Identifier created: ${JSON.stringify(identifier)}`);
        res.send(identifier);
    }
    catch (error) {
        console.error(`Error creating identifier for wallet address ${walletAddr}:`, error);
        res.status(500).send({ error: 'An error occurred while creating the identifier.' });
    }
});
app.get("/api/v0/confirm/", async (req, res) => {
    let privateKey = req.query.privatekey;
    let walletAddr = req.query.walletaddr;
    let identifier;
    // Use the private key directly without converting it
    console.log(privateKey + " " + walletAddr);
    try {
        identifier = await agentETH.didManagerGetByAlias({ alias: walletAddr });
        console.log(identifier);
    }
    catch (error) {
        console.log(error);
    }
    if (identifier) {
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
                    "kid": "key-1" + walletAddr,
                    privateKeyHex: privateKey
                },
            ],
            services: []
        });
        console.log(identifier);
        res.send(identifier);
    }
    catch (error) {
        console.error(error);
        res.status(500).send({ error: 'An error occurred while creating the identifier.' });
    }
});
app.get("/create_did_by_alias", async (req, res) => {
    let gotalias = req.query.alias;
    const identifier = await agent.didManagerCreate({ alias: gotalias });
    res.send(identifier);
});
app.get("/create_did", async (req, res) => {
    const identifier = await agent.didManagerCreate({});
    res.send(identifier);
});
// Define a route that returns a list of dids from the wallet
app.get('/get_own_did', async (req, res) => {
    const identifiers = await agent.didManagerFind();
    const identifiersETHR = await agentETH.didManagerFind();
    console.log(`There are ${identifiers.length} identifiers`);
    let list = [];
    if (identifiers.length > 0) {
        identifiers.map((id) => {
            list.push(id.did);
        });
    }
    if (identifiersETHR.length > 0) {
        identifiersETHR.map((id) => {
            list.push(id.did);
        });
    }
    res.send({ "dids": list });
});
// Define a route that returns a list of dids from the wallet
app.get('/get_own_did_eth', async (req, res) => {
    const identifiers = await agentETH.didManagerFind();
    console.log(`There are ${identifiers.length} identifiers`);
    let list = [];
    if (identifiers.length > 0) {
        identifiers.map((id) => {
            list.push(id.did);
        });
    }
    res.send({ "dids": list });
});
// Define a route that returns a did document from the wallet
app.get('/get_did_doc', async (req, res) => {
    let gotstring = req.query.did;
    // Choose the appropriate agent based on the presence of ":sepolia" in the did
    const agentToUse = !gotstring.includes(':sepolia') ? agentETH : agent;
    try {
        const identifier = await agentToUse.didManagerGet({ did: gotstring });
        console.log('identifier', identifier);
        res.send(identifier);
    }
    catch (error) {
        console.error('Error fetching DID document:', error);
        res.status(500).send({ error: 'Failed to fetch DID document' });
    }
});
function parseNestedJSON(obj) {
    let parsed = {};
    // Iterate over all keys in the object
    for (let key in obj) {
        // Check if the value corresponding to the key is an object
        if (typeof obj[key] === 'object' && obj[key] !== null) {
            // If it's an object, recursively parse it and assign the result to the key
            parsed[key] = parseNestedJSON(obj[key]);
        }
        else if (typeof obj[key] === 'string') {
            // If it's a string, try to parse it as JSON
            try {
                // Attempt to parse as JSON object
                parsed[key] = JSON.parse(obj[key]);
            }
            catch (error) {
                // If parsing as object fails, attempt to parse as JSON array
                try {
                    // Attempt to parse as JSON array
                    parsed[key] = JSON.parse(`[${obj[key]}]`);
                }
                catch (error) {
                    // If parsing fails, assign the string value as is
                    parsed[key] = obj[key];
                }
            }
        }
        else {
            // If it's not an object or a string, assign its value to the key
            parsed[key] = obj[key];
        }
    }
    return parsed;
}
// Define the route to store a verifiable credential
app.post('/store_vc', bodyParser.json(), async (req, res) => {
    try {
        console.log("here");
        console.log(req.body); // This should work
        // Log the keys of the JSON object
        const did = req.body.did;
        // Choose the appropriate agent based on the presence of "sepolia" in the did
        const agentToUse = !did.includes('sepolia') ? agentETH : agent;
        const decoded_jwt = jwtDecode(req.body.verifiableCredential);
        const verifiable_credential = format_jwt_decoded_to_VC(req.body.verifiableCredential, decoded_jwt);
        try {
            console.log(req.body.verifiableCredential);
            console.log(req.body.credentialSubject);
            let vc = ({ verifiableCredential: verifiable_credential });
            console.log("here is vc" + JSON.stringify(vc));
            // Use the selected agent to save the verifiable credential
            const hash = await agentToUse.dataStoreSaveVerifiableCredential(vc);
            res.send({ res: "OK", hash: hash });
        }
        catch (error) {
            console.log(error);
            // We'll proceed, but let's report it
            res.status(500).send({
                message: `error in store`
            });
        }
    }
    catch (error) {
        console.log(error);
        // Handle errors
        res.status(500).send({
            message: `error in processing`
        });
    }
});
// Define a route that issues a credential
app.post('/issue_verifiable_credential', async (req, res) => {
    console.log(req.body);
    let issuer_did = req.body.issuer;
    let holder_did = req.body.holder;
    let type_cred = req.body.type;
    const attributes = req.body.attributes;
    const toStore = req.body.store === true;
    let credential_subject_full = { ...{ id: holder_did }, ...attributes };
    let typeToPut = [];
    if (type_cred) {
        typeToPut.push(type_cred);
    }
    // Choose the appropriate agent based on the presence of "sepolia" in the issuer_did
    const agentToUse = !issuer_did.includes(':sepolia') ? agentETH : agent;
    try {
        let verifiableCredential = await agentToUse.createVerifiableCredential({
            credential: {
                "@context": [
                    "https://www.w3.org/ns/credentials/v2",
                ],
                issuer: { id: issuer_did },
                type: typeToPut,
                credentialSubject: credential_subject_full,
            },
            proofFormat: 'jwt',
            fetchRemoteContexts: true
        });
        if (toStore) {
            console.log("before storing" + JSON.stringify(verifiableCredential, null, 2));
            const hash = await agentToUse.dataStoreSaveVerifiableCredential({ verifiableCredential });
            console.log("stored: " + hash);
            res.send({ res: "OK", jwt: verifiableCredential.proof.jwt });
        }
        else {
            console.log("sending" + verifiableCredential.proof.jwt);
            res.send({ res: "OK", jwt: verifiableCredential.proof.jwt });
        }
    }
    catch (error) {
        console.log(error);
        // We'll proceed, but let's report it
        res.status(500).send({
            message: `credential issuer must be a DID managed by this agent`
        });
    }
});
// Define a route that issues a verifiable presentation
app.post('/issue_verifiable_presentation/holder_claim', async (req, res) => {
    const holderDid = req.body.holder;
    const typeCred = req.body.type;
    const attributes = req.body.attributes;
    const assertion = req.body.assertion;
    const toStore = req.body.store === true;
    // Choose the appropriate agent based on the presence of "sepolia" in the holderDid
    const agentToUse = !holderDid.includes('sepolia') ? agentETH : agent;
    try {
        const verifiablePresentation = await createVPwithHolderClaim(typeCred, assertion, holderDid, attributes);
        if (verifiablePresentation) {
            if (toStore) {
                const hash = await agentToUse.dataStoreSaveVerifiablePresentation({ verifiablePresentation });
                console.log("Stored: " + hash);
            }
            res.send({ res: "OK", jwt: verifiablePresentation.proof.jwt });
        }
        else {
            res.status(500).send({ message: "Failed to create verifiable presentation" });
        }
    }
    catch (error) {
        console.error(error);
        res.status(500).send({ message: "Internal server error" });
    }
});
// Define a route that returns a list of verifiable presentations from the wallet
app.get('/list_verifiable_presentations', async (req, res) => {
    try {
        // Retrieve the list of verifiable presentations from the wallet
        const verifiablePresentations = await agent.dataStoreORMGetVerifiablePresentations();
        verifiablePresentations.concat(await agentETH.dataStoreORMGetVerifiablePresentations());
        // Send the list of verifiable presentations as the response
        res.send(verifiablePresentations);
    }
    catch (error) {
        // If an error occurs, send an error response
        console.error(error);
        res.status(500).send({ message: "Internal server error" });
    }
});
// Define a route that returns a list of verifiable credentials from wallet
app.get('/api/v0/list-verifiable-credentials-with-type', async (req, res) => {
    console.log("received request to get verifiable credentials with type");
    let queryParam = req.query.type;
    const query = {
        where: [
            {
                column: 'type',
                value: ['VerifiableCredential,' + queryParam],
                op: 'Equal',
            }
        ],
        order: [{ column: 'issuanceDate', direction: 'ASC' }],
    };
    // Fetch results from both data stores
    let response1 = await agent.dataStoreORMGetVerifiableCredentials(query);
    let response2 = await agentETH.dataStoreORMGetVerifiableCredentials(query);
    // Concatenate the results
    let concatenatedResponse = response1.concat(response2);
    console.log("respon" + concatenatedResponse.toString());
    res.send(concatenatedResponse);
});
// Define a route that returns a list of verifiable presentations from the wallet based on a specific type
app.get('/list_verifiable_presentations_with_type', async (req, res) => {
    try {
        // Extract the type query parameter from the request
        const queryParam = req.query.type;
        // Define the query to filter verifiable presentations by type
        const query = {
            where: [
                {
                    column: 'type',
                    value: ['VerifiablePresentation,' + queryParam],
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
        console.log("response" + concatenatedResponse.toString());
        res.send(concatenatedResponse);
    }
    catch (error) {
        // If an error occurs, send an error response
        console.error(error);
        res.status(500).send({ message: "Internal server error" });
    }
});
// Define a route that returns ONE verifiable credentials from wallet given an HASH
app.get('/get_verifiable_credential', async (req, res) => {
    let hash = req.query.hash_cred;
    let respose = await agent.dataStoreGetVerifiableCredential({ hash });
    if (!respose) {
        //if not in the agent connected to sepolia, find it in the ETH sepolia agent
        respose = await agentETH.dataStoreGetVerifiableCredential({ hash });
    }
    res.send(respose);
});
//route to get a verifiable presentation from qr code
app.post('/decode_jwt/image', async (req, res) => {
    let png_data = req.body.img_data;
    const buffer = Buffer.from(png_data, 'base64');
    console.log(buffer.length + "len of buf\n");
    const png = PNG.sync.read(buffer);
    const code = decode(Uint8ClampedArray.from(png.data), png.width, png.height);
    console.log("after code decode");
    let code_jwt = code?.data;
    //remove initial and final " as the string seems double stringified
    if (code_jwt.startsWith('"') && code_jwt.endsWith('"')) {
        code_jwt = code_jwt.substring(1, code_jwt.length - 1);
    }
    let decoded = jwtDecode(code_jwt);
    let result = decoded; //result can be any json if not in the following two categories
    if (decoded.hasOwnProperty('vc')) {
        //if a veriable credential
        let result = format_jwt_decoded_to_VC(code_jwt, decoded);
        res.send(result);
        return;
    }
    else if (decoded.hasOwnProperty('vp')) {
        let result = format_jwt_decoded_to_VP(code_jwt, decoded);
        res.send(result);
        return;
    }
    res.send(result);
});
// Define a route that returns a qr-code for a verifiable credential
app.get('/get_qr_code/wallet_hash', async (req, res) => {
    let hash = req.query.hash;
    let loaded_credential;
    //loaded_credential = await agent.dataStoreGetVerifiableCredential({hash: hash})
    try {
        loaded_credential = await agent.dataStoreGetVerifiableCredential({ hash: hash });
        console.log(loaded_credential.proof['jwt']);
        qrcode.toFile('./filename.png', (loaded_credential.proof['jwt']), {
            color: {
                dark: '#000000', // Blue dots
                light: '#ffffff' // White background
            }
        }, function (err) {
            if (err)
                throw err;
            console.log('done');
        });
        // reading of qr code from file and obtain the jwt
        // code obtained from https://stackoverflow.com/questions/51948472/image-base64-string-to-uint8clampedarray
        // mixed with https://github.com/pngjs/pngjs/blob/c565210c602527eb459f857eeb78183997482d5b/README.md?plain=1#L258
        let data = fs.readFileSync('filename.png');
        const png = PNG.sync.read(data);
        console.log("this is png " + png);
        const code = decode(Uint8ClampedArray.from(png.data), png.width, png.height);
        let code_jwt = code?.data;
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
        let decoded_jwt = jwtDecode(code_jwt);
        // Set the appropriate content type in the response headers
        res.setHeader('Content-Type', 'image/png');
        res.send(data);
    }
    catch (Error) {
        res.status(500).send({
            message: `Response: unsupported engine}`
        });
    }
    //res.send({encoded_jwt:code_jwt,decoded_jwt:decoded_jwt,origin:format_jwt_decoded(code_jwt,decoded_jwt)})
});
// Define a route that returns a qr-code for a verifiable credential
app.post('/get_qr_code/jwt', async (req, res) => {
    let jwt = req.body.jwt;
    try {
        qrcode.toFile('./filename.png', jwt, {
            color: {
                dark: '#000000', // Blue dots
                light: '#ffffff' // White background
            }
        }, async function (err) {
            if (err) {
                throw err;
            }
            else {
                try {
                    // Wait for the file to be written before reading it
                    let data = await fs.promises.readFile('./filename.png');
                    console.log(data);
                    res.setHeader('Content-Type', 'image/png');
                    res.send(data);
                }
                catch (error) {
                    console.error('Error reading QR code file:', error);
                    res.status(500).send({
                        message: 'Error reading QR code file'
                    });
                }
            }
        });
    }
    catch (error) {
        console.error('Error generating QR code:', error);
        res.status(500).send({
            message: 'Error generating QR code'
        });
    }
});
//route to convert a jwt to VP or VC (or any other text)
app.get("/decode_jwt", async (req, res) => {
    let jwt = req.query.jwt;
    try {
        let decoded = jwtDecode(jwt);
        let result = decoded; //result can be any json if not in the following two categories
        if (decoded.hasOwnProperty('vc')) {
            //if a veriable credential
            let result = format_jwt_decoded_to_VC(jwt, decoded);
            res.send(result);
            return;
        }
        else if (decoded.hasOwnProperty('vp')) {
            let result = format_jwt_decoded_to_VP(jwt, decoded);
            res.send(result);
            return;
        }
    }
    catch (error) {
        res.status(500).send("error decoding");
    }
});
function convertTimestampToIssuanceDate(timestampInSeconds) {
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
function format_jwt_decoded_to_VC(jwt_encoded, jwt_decoded) {
    // Create an empty object
    let obj = {};
    let credSubj = {};
    let proofObj = {};
    let issuerObj = {};
    // Example usage
    console.log("date is" + jwt_decoded.nbf);
    const issuanceDate = convertTimestampToIssuanceDate(jwt_decoded.nbf);
    console.log("Issuance Date:", issuanceDate);
    obj["issuanceDate"] = issuanceDate;
    obj["@context"] = jwt_decoded.vc["@context"];
    console.log("obj[\"@context\"] =" + obj["@context"] + "\n\n");
    obj.type = jwt_decoded.vc.type;
    credSubj = jwt_decoded.vc.credentialSubject;
    credSubj.id = jwt_decoded.sub;
    obj.credentialSubject = credSubj;
    issuerObj.id = jwt_decoded.iss;
    obj.issuer = issuerObj;
    proofObj.type = "JwtProof2020";
    proofObj.jwt = jwt_encoded;
    obj.proof = proofObj;
    return (obj);
}
function format_jwt_decoded_to_VP(jwt_encoded, jwt_decoded) {
    // Create an empty object
    let obj = {};
    let credentials = {};
    let proofObj = {};
    console.log("the keys of deconded" + jwt_decoded.keys);
    // Example usage
    console.log("date is" + jwt_decoded.nbf);
    const issuanceDate = convertTimestampToIssuanceDate(jwt_decoded.nbf);
    console.log("Issuance Date:", issuanceDate);
    obj["issuanceDate"] = issuanceDate;
    obj["@context"] = jwt_decoded.vp["@context"];
    obj.type = jwt_decoded.vp.type;
    obj.holder = jwt_decoded.iss; //iss corresponds to the holder, the one creating the vp
    obj.id = jwt_decoded.jti; //jti corresponds to the id (Which can be a uuid) assigned to the claim
    credentials = jwt_decoded.vp.verifiableCredential;
    let jwt_cred;
    for (let i = 0; i < credentials.length; i++) {
        if (!credentials[i].hasOwnProperty('vc')) { // if already decoded vc, keep as it is
            //if not then it is encoded as jwt, we decode and assign
            jwt_cred = jwtDecode(credentials[i]);
            credentials[i] = format_jwt_decoded_to_VC(credentials[i], jwt_cred); // assign decoded jwt
        }
    }
    obj.verifiableCredential = credentials;
    proofObj.type = "JwtProof2020";
    proofObj.jwt = jwt_encoded;
    obj.proof = proofObj;
    return (obj);
}
//TODO VERIFY SHOULD BE FROM DID:ETHR AGENT
async function createVPwithHolderClaim(typeVP, assertion, holder, jsonVar) {
    let presentationPayload = {};
    presentationPayload.type = ["VerifiablePresentation", typeVP];
    presentationPayload["@context"] = ["https://www.w3.org/ns/credentials/v2"];
    presentationPayload.holder = holder;
    const agentToUse = !holder.includes('sepolia') ? agentETH : agent;
    //create a uuid for the VP
    let uuid = crypto.randomUUID();
    presentationPayload.id = uuid;
    let vc_payload = {};
    let issuer_data = { id: holder };
    vc_payload.issuer = issuer_data;
    vc_payload["@context"] = ["https://www.w3.org/ns/credentials/v2"];
    vc_payload.type = ['VerifiableCredential', 'VCPresentation', "VCfor" + typeVP];
    let vc_cred_subj = jsonVar;
    //vc_cred_subj['assertion'] = 'This VP is submitted by the subject as evidence of  VC propagation'
    vc_cred_subj['assertion'] = assertion;
    vc_cred_subj['id'] = uuid;
    vc_payload.credentialSubject = vc_cred_subj;
    try {
        let verifiableCredential = await agentToUse.createVerifiableCredential({
            credential: vc_payload,
            proofFormat: 'jwt',
            fetchRemoteContexts: true
        });
        presentationPayload.verifiableCredential = [verifiableCredential];
        let verifiablePresentation = await agentToUse.createVerifiablePresentation({
            presentation: presentationPayload,
            proofFormat: 'jwt'
        });
        return verifiablePresentation;
    }
    catch (error) {
        console.log(error);
        return null;
    }
    return null;
}
//verify_credential
app.post('/verify', async (req, res) => {
    const credential = req.body.credential;
    // Choose the appropriate agent based on the presence of "sepolia" in the holderDid
    const agentToUse = !req.body.credential.issuer.id.includes(':sepolia') ? agentETH : agent;
    const result = await agentToUse.verifyCredential({
        credential: credential
    });
    console.log("result of verification" + result.verified);
    res.send({ res: result.verified });
});
app.post('/verify/vp', async (req, res) => {
    const vp = req.body.vp;
    const did = req.body.vp.holder;
    const result = await (verifyPresentation(vp, did));
    res.send({ res: result.verified });
});
async function verifyPresentation(VP, did) {
    //simple verification call, you need to provide the internal content of VerifiablePresentation:
    const agentToUse = !did.includes(':sepolia') ? agentETH : agent;
    let ris = await agentToUse.verifyPresentation({ presentation: VP });
    return ris;
}
// Listen on port 3001
app.listen(3001, () => {
    console.log('Server is running on port 3001');
});
