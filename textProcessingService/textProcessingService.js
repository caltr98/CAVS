const express = require('express');
const cors = require('cors');
const fs = require('fs');
const axios = require('axios')
const outPort = 4500;
const app = express();
const extractorEngines = ["BERT","LLM","BERT+LLM"]
const enricherEngines = ["YAGO"]

app.use(cors());

let yagoServiceCallerEndpoint,keyBertServiceCallerEndpoint,keyLLMServiceCallerEndpoint;
// Function to read config.json and update yagoServiceCallerEndpoint
function updateConfig() {
    fs.readFile('config.json', 'utf8', (err, data) => {
        if (err) {
            console.error('Error reading config.json:', err);
            return;
        }
        try {
            const config = JSON.parse(data);
            yagoServiceCallerEndpoint = config.yagoServiceCallerEndpoint;
            keyBertServiceCallerEndpoint = config.keyBertServiceEndpoint;
            keyLLMServiceCallerEndpoint = config.keyLLMServiceEndpoint;

            console.log('keyBertServiceCallerEndpoint updated:', keyBertServiceCallerEndpoint);
            console.log('keyLLMServiceCallerEndpoint updated:', keyLLMServiceCallerEndpoint);
            console.log('yagoServiceCallerEndpoint updated:', yagoServiceCallerEndpoint);
        } catch (parseError) {
            console.error('Error parsing JSON:', parseError);
        }
    });
}

// Initial configuration setup
updateConfig();

// Watch for changes to config.json
fs.watchFile('config.json', (curr, prev) => {
    console.log('config.json changed');
    updateConfig();
});

//ROUTE 1 get available extractors
app.get("/api_extractor", (req, res) => {
    console.log(`App listening on port${outPort}`)
    res.json({ "extractor_engines": extractorEngines })
});

//ROUTE 2 get available enricher
app.get("/api_enricher", (req, res) => {
    console.log(`App listening on port${outPort}`)
    res.json({ "enricher_engines": enricherEngines })
});


//ROUTE 3 ->  Keyword extraction
app.get("/extract", async (req, res) => {
    const document = req.query.document;
    const engine = req.query.engine;
    console.log(engine)
    if(!extractorEngines.includes(engine)){
        console.log("Unsupported engine");
        res.status(500).send({
            message: `Response: unsupported engine}`
        });
    }
    if(engine === "BERT"){
        try {
            console.log("keybertendpoint"+keyBertServiceCallerEndpoint)
            // Create a new instance of Axios for each request
            console.log("requested words"+document)
            const response = await axios.get(`${keyBertServiceCallerEndpoint}/keywords`, {
                timeout: 1125000,
                params: {
                    doc: document
                }
            });
            let keywords = response.data.keywords;

            console.log("received result"+keywords)
            res.json({ "keyword": keywords });
        } catch (err) {
            if (err.code === 'ECONNABORTED') {
                console.log("Request timed out");
                res.status(502).send({
                    message: `Response: service endpoint timed out}`
                });
            } else {
                console.log(err.message);
                res.status(500).send({
                    message: `Unknown error in sending request to service endpoint here the error mess`+err.message
                });
            }
        }
    }
    else if(engine === "LLM"){
        try {
            console.log(keyLLMServiceCallerEndpoint)
            // Create a new instance of Axios for each request
            const response = await axios.get(`${keyLLMServiceCallerEndpoint}/keywords_only_LMM`, {
                timeout: 25000,
                params: {
                    doc: document
                }
            });
            let keywords = response.data.keywords;

            console.log("received result"+keywords)
            res.json({ "keyword": keywords });
        } catch (err) {
            if (err.code === 'ECONNABORTED') {
                console.log("Request timed out");
                res.status(502).send({
                    message: `Response: service endpoint timed out}`
                });
            } else {
                console.log(err.message);
                res.status(500).send({
                    message: `Unknown error in sending request to service endpoint`
                });
            }
        }
    }
    else if(engine === "BERT+LLM"){
        try {
            console.log(keyLLMServiceCallerEndpoint)
            // Create a new instance of Axios for each request


            const response = await axios.get( `${keyLLMServiceCallerEndpoint}/keywords_both`, {
                timeout: 45000,
                params: {
                    doc: document
                }
            });
            let keywords = response.data.keywords;

            console.log("received result"+keywords)
            res.json({ "keyword": keywords });
        } catch (err) {
            if (err.code === 'ECONNABORTED') {
                console.log("Request timed out");
                res.status(502).send({
                    message: `Response: service endpoint timed out}`
                });
            } else {
                console.log(err.message);
                res.status(500).send({
                    message: `Unknown error in sending request to service endpoint`
                });
            }
        }
    }

});

//ROUTE 4 ->  Keyword enrichment
app.get("/enrich_same_level", async (req, res) => {
    console.log(req.query)
    const keywords = req.query.keywords;
    const engine = req.query.engine;
    console.log(engine)
    console.log(keywords)

    if(!enricherEngines.includes(engine)){
        console.log("Unsupported engine");
        res.status(500).send({
            message: `Response: unsupported engine}`
        });
    }
    if(engine === "YAGO"){
        try {
            let extrakeywords = []
            console.log(keyBertServiceCallerEndpoint)
            // Create a new instance of Axios for each request
            for(let i=0;i<keywords.length;i++) {
                const response = await axios.get(`${yagoServiceCallerEndpoint}/querySameLevelHierarchy`, {
                    timeout: 25000,
                    params: {
                        element: keywords[i]
                    }
                });
                console.log("respose" + response)
                //concat array into one
                extrakeywords = extrakeywords.concat(response.data.results);
            }
            console.log("received result"+extrakeywords)
            res.json({ "keyword": extrakeywords });
        } catch (err) {
            if (err.code === 'ECONNABORTED') {
                console.log("Request timed out");
                res.status(502).send({
                    message: `Response: service endpoint timed out}`
                });
            } else {
                console.log(err.message);
                res.status(500).send({
                    message: `Unknown error in sending request to service endpoint`
                });
            }
        }
    }
});

//ROUTE 4 ->  Keyword enrichment, upper level, eg Bitcoin to Blockchain
app.get("/enrich_upper_level", async (req, res) => {
    console.log(req.query)
    const keywords = req.query.keywords;
    const engine = req.query.engine;
    console.log(engine)
    console.log(keywords)

    if(!enricherEngines.includes(engine)){
        console.log("Unsupported engine");
        res.status(500).send({
            message: `Response: unsupported engine}`
        });
    }
    if(engine === "YAGO"){
        try {
            let extrakeywords = []
            console.log(keyBertServiceCallerEndpoint)
            // Create a new instance of Axios for each request
            for(let i=0;i<keywords.length;i++) {
                const response = await axios.get(`${yagoServiceCallerEndpoint}/queryUpperHierarchy`, {
                    timeout: 25000,
                    params: {
                        element: keywords[i]
                    }
                });
                console.log("respose" + response)
                //concat array into one
                extrakeywords = extrakeywords.concat(response.data.results);
            }
            console.log("received result"+extrakeywords)
            res.json({ "keyword": extrakeywords });
        } catch (err) {
            if (err.code === 'ECONNABORTED') {
                console.log("Request timed out");
                res.status(502).send({
                    message: `Response: service endpoint timed out}`
                });
            } else {
                console.log(err.message);
                res.status(500).send({
                    message: `Unknown error in sending request to service endpoint`
                });
            }
        }
    }
});


app.listen(outPort, () => console.log(`Server running on port: ${outPort}`));
