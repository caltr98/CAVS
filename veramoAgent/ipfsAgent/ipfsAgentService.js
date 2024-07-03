//guide https://www.youtube.com/watch?v=q5bKjuu3kdE

const cors = require("cors");
const express = require('express');
const filesystem = require('fs');
const crypto = require('crypto');


const outport = 4201
const app = express();
app.use(cors())
app.use(express.json()); // second endpoint


let fs;
let definition;
let globalKeyInfo;
let globalPeerId;
async function createNode(){
    const {createHelia} = await  import('helia')
    const {unixfs} = await import("@helia/unixfs");
    const {FsBlockstore} = await import('blockstore-fs')
    const helia = await createHelia({
        blockstore: new FsBlockstore ('./persisted')
    });
    const { ipns } = await import( '@helia/ipns')
    definition = ipns(helia)

    // Read the contents of the secret.json file
    const secretJson = JSON.parse(filesystem.readFileSync('./secret.json'));
    // Check if the PKCS field exists
    if (secretJson.PKCS) {
        const importedKey = await helia.libp2p.services.keychain.importKey(secretJson.name, secretJson.PKCS,secretJson.password);
        globalKeyInfo = importedKey
        console.log("Key imported:", importedKey);
    }
    else{
        try {
            // PKCS field doesn't exist, create and store the key
            // Create an RSA key with a valid name
            const keyInfo = await helia.libp2p.services.keychain.createKey(secretJson.name, "rsa");
            console.log("RSA key created:", keyInfo);

            // Export the key and store it
            console.log("this is name"+secretJson)
            const exportedKey = await helia.libp2p.services.keychain.exportKey(secretJson.name, secretJson.password);
            console.log("Exported key:", exportedKey);

            // Write the key information to secret.json
            secretJson.PKCS = exportedKey;
            await filesystem.writeFileSync('./secret.json', JSON.stringify(secretJson, null, 2), 'utf-8');
            globalKeyInfo = keyInfo;
            console.log("Key information stored in secret.json.");
        } catch (error) {
            console.error("Error creating and storing key:", error);
            throw error; // Propagate the error for handling at a higher level
        }
    }
    // Export the peer ID associated with the created key
    console.log("keyinfo "+ globalKeyInfo.name)

    //try to put all the logic here :c
    globalPeerId = await helia.libp2p.services.keychain.exportPeerId(globalKeyInfo.name);

    console.log("this is name "+globalPeerId)
    fs = unixfs(helia); //init
}

app.get('/peer_id', async (req, res) => {
    if(!fs) {
        await createNode();
    }
    console.log(globalPeerId)
    res.send({peer_id:globalPeerId});
});

app.get('/set_secrets', async (req, res) => {
    const usr = req.query.name
    const psw = req.query.psw

    const json_query = {name:usr,password:psw}
    const json_read = JSON.parse(filesystem.readFileSync('./secret.json'))
    if(json_read.name && json_read.name == json_query.name){
        if(json_read.password && json_read.password == json_query.password){ //password matched, send response
            res.send({response:"OK"});
            return;
        }
    }
    //password is changed, need to change key and peerID or first time creating
    const file = JSON.stringify(json_query,null,2)
    filesystem.writeFileSync("./secret.json", file);
    createNode()
    res.send({response:"OK"});

});


app.post('/upload', async (req, res) => {
    if(!fs) {
        await createNode();
    }
    const data = req.body.text;
    const force = req.body.force //this forces the node to upload the file again

    //upload only if data was not already uploaded
    let jsonData = JSON.parse(filesystem.readFileSync("indexing.json"));

    // Create SHA-256 hash
    const hash = crypto.createHash('sha256');
    hash.update(data);

    // Get the hexadecimal digest of the hash
    const sha256Hash = hash.digest('hex');

    // we use the hash to check if a cid already exists
    if(jsonData.hasOwnProperty(sha256Hash) && !force) { // if yes we can return the cid
        // Retrieve the CIDs associated with the user
        const requesterCIDs = jsonData[sha256Hash];
        res.status(200).send({CID:requesterCIDs})
    }
    else { // otherwise the upload to the node
        const encoder = new TextEncoder();
        //store the data on node and obtain a cid
        const cid = (await fs.addBytes(encoder.encode(data))).toString();

        // Read the JSON indexing
        // Add new storer with CID or add CID to existing one
        jsonData[sha256Hash] = cid; // Create a mapping between sha256Hash and CID
        // Write the JSON file
        filesystem.writeFileSync("indexing.json", JSON.stringify(jsonData));
        console.log(`returning CID ` + cid);
        res.status(201).send({CID:cid})//201 because we created a resource
    }
});




/*
app.get('/fetch', async (req, res) => {
    const fs = await createNode();
    const cid = req.query.gotCID;
    //check cid
    if (!cid) {
        res.status(400).send("no file found");
    }
    let text;
    const decoder = new TextDecoder();
    //fetch with a timeout of 60 seconds
    const timeout = new Promise((resolve, reject) => {
        let id = setTimeout(() => {
            clearTimeout(id);
            reject('Timed out in ' + 60000 + 'ms.');
        }, 60000);
    });
    const fetch = (async () => {
        for await (const chunks of fs.cat(cid)) {
            text = decoder.decode(chunks, { stream: true });
        }
        return text;
    })();
    //race between the fetch operation or the timeout operation
    return Promise.race([
        fetch,
        timeout
    ])
        .then((text) => {
            //it won the fetch
            res.status(200).send(text);
        })
        .catch((error) => {
            //it won the timeout
            res.status(500).send({ error: 'Fetch operation timed out.' });
        });
});
*/
async function retrieveByCID(cid) {
    if(!fs){
        await createNode()
    }
    //check cid
    let text;
    const decoder = new TextDecoder();
    //fetch with a timeout of 60 seconds
    const timeout = new Promise((resolve, reject) => {
        let id = setTimeout(() => {
            clearTimeout(id);
            reject('Timed out in ' + 60000 + 'ms.');
        }, 60000);
    });
    const fetch = (async () => {
        for await (const chunks of fs.cat(cid)) {
            text = decoder.decode(chunks, { stream: true });
        }
        return text;
    })();
    //race between the fetch operation or the timeout operation
    return Promise.race([
        fetch,
        timeout
    ])
        .then((text) => {
            //it won the fetch
            console.log("text obtained"+text)
            return text
        })
        .catch((error) => {
            //it won the timeout
            return null
        });
}



app.get('/retrieve',async (req, res) => {
    const cid = req.query.cid;

    let result =  await retrieveByCID(cid);
    if(result){
        //returns {cid,path} json
        res.send({result})
    }
    else{
        res.status(500).send("Could not find in time(60sec)")
    }
});

async function retrieveCIDByPeerID(peerID) {
    if (!fs) {
        await createNode();
    }
    const timeout = new Promise((resolve, reject) => {
        let id = setTimeout(() => {
            clearTimeout(id);
            reject('Timed out in ' + 60000 + 'ms.');
        }, 60000);
    });
    const fetch = (async () => {
        return definition.resolve(peerID);
    })();
    //race between the fetch operation or the timeout operation
    return Promise.race([
        fetch,
        timeout
    ])
        .then((cid) => {
            //it won the fetch
            let string = JSON.stringify(cid.cid)
            // Remove escape sequences and non-alphanumeric characters
            string = string.replace(/[^a-zA-Z0-9]/g, "")
            console.log(string);
            return string
        })
        .catch((error) => {
            //it won the timeout
            return null
        });

}

app.get('ipns/retrieve',async (req, res) => {
    const peerID = req.body.peer_id;

    let result =  await retrieveCIDByPeerID(peerID);
    if(result){
        //returns {cid,path} json
        res.send({result})
    }
    else{
        res.status(500).send("Could not find in time(60sec)")
    }
});
app.post('/ipns/append', async (req, res) => {
    if(!fs) {
        await createNode();
    }
    let json_data = req.body.text; // Extracting the text from the request body
    let cid = await retrieveCIDByPeerID(globalPeerId);
    let json_array;
    let retrieved;
    console.log("cid before all "+ cid)

    if(cid){
        console.log("cid before retrieve "+ cid)
        retrieved = await retrieveByCID(cid);
        console.log("what is retrieved"+ retrieved)
        if(retrieved) {
            console.log("post insert" + JSON.stringify(retrieved,null,2));

            json_array = JSON.parse(retrieved);
            json_array.data.push(json_data); // Add the new data to the existing JSON array
            console.log("post push" + JSON.stringify(json_array, null, 2));
        }
    }

    if(!cid || (cid && !retrieved)){
        json_array = { data: [] }; // Create a new JSON array if CID is not found or retrieved is falsy
        json_array.data.push(json_data);
        console.log("post init"+ JSON.stringify(json_array,null,2));
    }

    // Encode the JSON array into bytes
    const encoder = new TextEncoder();
    const encodedData = encoder.encode(JSON.stringify(json_array));

    // Store the data on the node and obtain a CID
    cid = (await fs.addBytes(encodedData)).toString();

    // Publish the CID
    await definition.publish(globalPeerId, cid);

    // Send response
    res.status(201).send({ cid: cid });
});

function startServer() {
    app.listen(outport, () => {
        console.log("Listening on port " + outport);
    });

    // Event listener for unhandled exceptions
    process.on('uncaughtException', (error) => {
        console.error('Uncaught Exception:'+ error);
        // Restart the server or take other appropriate action
        //startServer(); // Restart the server
    });

    // Event listener for unhandled promise rejections
    process.on('unhandledRejection', (reason, promise) => {
        console.error('Unhandled Rejection' + reason);
        // Restart the server or take other appropriate action
        //startServer(); // Restart the server
    });

    // Event listener for specific exception: AbortError
    process.on('AbortError', (error) => {
        //this seems to happen with libp2p
        console.log('AbortError happened');
        // Restart the server or take other appropriate action
        //startServer(); // Restart the server
    });
}



// new way is try to assign a name

// Start the server
startServer();

async function createAndStoreKey() {
    try {
        // Read the contents of the secret.json file
        const secretJson = JSON.parse(filesystem.readFileSync('secret.json'));

        // Check if the PKCS field exists
        if (secretJson.PKCS) {
            // PKCS field exists, exit the function
            console.log("PKCS field already exists in secret.json. Exiting...");
            return;
        }

        // PKCS field doesn't exist, create and store the key
        const { createHelia } = await import('helia');
        const { unixfs } = await import("@helia/unixfs");
        const { FsBlockstore } = await import('blockstore-fs');
        const helia = await createHelia({
            blockstore: new FsBlockstore('./persisted')
        });
        const { ipns } = await import('@helia/ipns');
        const definition = ipns(helia);

        // Create an RSA key with a valid name
        const keyInfo = await helia.libp2p.services.keychain.createKey(secretJson.name, "rsa");
        console.log("RSA key created:", keyInfo);

        // Export the key and store it
        console.log("secpas"+secretJson.password)
        const exportedKey = await helia.libp2p.services.keychain.exportKey(secretJson.name, secretJson.password);
        console.log("Exported key:", exportedKey);

        // Write the key information to secret.json
        secretJson.PKCS = exportedKey;
        await filesystem.writeFileSync('secret.json', JSON.stringify(secretJson, null, 2), 'utf-8');
        console.log("Key information stored in secret.json.");
    } catch (error) {
        console.error("Error creating and storing key:", error);
        throw error; // Propagate the error for handling at a higher level
    }
}

async function retrieveOrCreateKey() {
    // Read the contents of the secret.json file
    const secretJson = JSON.parse(filesystem.readFileSync('secret.json'));
    // Check if the PKCS field exists
    if (!secretJson.PKCS) {
        // PKCS field does not exists, call createAndStoreKey to create it and add to keychain in this session
        console.log("PKCS field already exists in secret.json. Exiting...");
        createAndStoreKey()
    }
    else{
        // PKCS field exists, import the key
        const { createHelia } = await import('helia');
        const { unixfs } = await import("@helia/unixfs");
        const { FsBlockstore } = await import('blockstore-fs');
        const helia = await createHelia({
            blockstore: new FsBlockstore('./persisted')
        });
        const { ipns } = await import('@helia/ipns');
        const definition = ipns(helia);

        const importedKey = await helia.libp2p.services.keychain.importKey(secretJson.name, secretJson.PKCS,secretJson.password);
        globalKeyInfo = importedKey
        console.log("Key imported:", importedKey);
         // Exit the function after importing the key
    }
}


// Define the function to retrieve the key
async function retrieveKey() {
    try {
        const {createHelia} = await  import('helia')
        const {unixfs} = await import("@helia/unixfs");
        const {FsBlockstore} = await import('blockstore-fs')
        const helia = await createHelia({
            blockstore: new FsBlockstore ('./persisted')
        });
        const { ipns } = await import( '@helia/ipns')
        definition = ipns(helia)

        // Get the key by its name
        const keyInfo = await helia.libp2p.services.keychain.exportKey("local1","mypass");
        // Return the key information
        return keyInfo;
    } catch (error) {
        console.error("Error retrieving key:", error);
        throw error; // Propagate the error for handling at a higher level
    }
}



