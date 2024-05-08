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
async function createNode(){
    const {createHelia} = await  import('helia')
    const {unixfs} = await import("@helia/unixfs");
    const {FsBlockstore  } = await import('blockstore-fs')
    const helia = await createHelia({
        blockstore: new FsBlockstore ('./persisted')
    });
    fs = unixfs(helia); //init
}

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
function startServer() {
    app.listen(outport, () => {
        console.log("Listening on port " + outport);
    });

    // Event listener for unhandled exceptions
    process.on('uncaughtException', (error) => {
        console.error('Uncaught Exception:', error);
        // Restart the server or take other appropriate action
        //startServer(); // Restart the server
    });

    // Event listener for unhandled promise rejections
    process.on('unhandledRejection', (reason, promise) => {
        console.error('Unhandled Rejection:', reason);
        // Restart the server or take other appropriate action
        //startServer(); // Restart the server
    });

    // Event listener for specific exception: AbortError
    process.on('AbortError', (error) => {
        //this seems to happen with libp2p
        console.error('AbortError happened');
        // Restart the server or take other appropriate action
        //startServer(); // Restart the server
    });
}

// Start the server
startServer();
