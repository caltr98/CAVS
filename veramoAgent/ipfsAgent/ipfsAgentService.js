//guide https://www.youtube.com/watch?v=q5bKjuu3kdE

const cors = require("cors");
const express = require('express');
const filesystem = require('fs');
const app = express(cors());

app.use(express.json()); // second endpoint

let hashMap = new Map();

async function createNode(){
    const {createHelia} = await  import('helia')
    const {unixfs} = await import("@helia/unixfs");
    const {FsBlockstore  } = await import('blockstore-fs')
    const helia = await createHelia({
        blockstore: new FsBlockstore ('./persisted')
    });
    const fs = unixfs(helia);
    return fs;
}

app.post('/upload', async (req, res) => {
    const fs = await createNode();
    const identityId = req.body.identityId;
    const data = req.body.text;

    const encoder = new TextEncoder();
    const cid = await fs.addBytes(encoder.encode(data));
    // Read the JSON indexing
    let jsonData = JSON.parse(filesystem.readFileSync("indexing.json"));
    // Add new storer with CID or add CID to existing one
    jsonData.newData = "some value";
    if(jsonData.hasOwnProperty(identityId)){ // Extend index for storer if already has a structure
        let storerData = jsonData[identityId];
        storerData.push(cid); // Push the CID to the array of CIDs associated with the storer
    } else {
        jsonData[identityId] = [cid]; // Create a new array with CID if storer does not exist in the index
    }

    // Write the JSON file
    filesystem.writeFileSync("indexing.json", JSON.stringify(jsonData));
    console.log(`returning CID `+cid);
    res.status(201).send({CID: cid})//201 because we created a resource
});

app.get('/fetch', async (req,res)=>{
    const fs = await createNode();
    const cid = req.query.gotCID
    //check cid
    if(!cid){
        res.status(400).send("no file found")
    }
    let text;
    const decoder = new TextDecoder();
    for await(const chunks of fs.cat(cid)){
        text = decoder.decode(chunks,{stream:true})
    }
    res.status(200).send(text)
})


// Endpoint for fetching all cid from identifier
app.get("/list/cid", async (req, res) => {
    const idRequester = req.body.idRequester;

    try {
        // Read the JSON indexing
        const jsonData = JSON.parse(filesystem.readFileSync("indexing.json"));

        // Check if the user exists in the index
        if (!jsonData.hasOwnProperty(idRequester)) {
            return res.status(404).json({"error": "Requester not found"});
        }

        // Retrieve the CIDs associated with the user
        const requesterCIDs = jsonData[idRequester];

        res.json({"requesterCIDs": requesterCIDs});
    } catch (error) {
        res.status(500).json({"error": "Internal server error"});
    }
});


app.listen(4201,()=>{
    console.log("listening")
})
