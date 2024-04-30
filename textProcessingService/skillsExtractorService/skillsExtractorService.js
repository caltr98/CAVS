const express = require('express');
const cors = require('cors');
const fs = require('fs');
const axios = require('axios')
const outPort = 4501;
const app = express();
const skillsEngines = ["OJD_DAPS","GPT3.5"]

app.use(cors());

let ojdServiceEndpoint,gptServiceEndpoint

// Function to read config.json and update yagoServiceCallerEndpoint
function updateConfig() {
    fs.readFile('config.json', 'utf8', (err, data) => {
        if (err) {
            console.error('Error reading config.json:', err);
            return;
        }
        try {
            const config = JSON.parse(data);
            ojdServiceEndpoint = config.ojd_daps_ServiceEndpoint;
            gptServiceEndpoint = config.gptSkillServiceEndpoint;

            console.log('gptServiceEndpoint updated:', gptServiceEndpoint);
            console.log('ojdServiceEndpoint updated:', ojdServiceEndpoint);
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

//ROUTE 1 get available skill matchers
app.get("/api_skills", (req, res) => {
    console.log(`App listening on port${outPort}`)
    res.json({ "skills_engines": skillsEngines })
});



//ROUTE 2 ->  Keyword extraction
app.get("/keyword_to_skills", async (req, res) => {
    const keywords = req.query.keywords;
    const engine = req.query.engine;
    console.log(engine)
    if(!skillsEngines.includes(engine)){
        console.log("Unsupported engine");
        res.status(500).send({
            message: `Response: unsupported engine}`
        });
    }
    if(engine === "OJD_DAPS"){
        try {
            console.log(ojdServiceEndpoint)
            // Create a new instance of Axios for each request
            console.log(keywords)
            const jsonObject = {};
            keywords.forEach((value, index) => {
                jsonObject[index.toString()] = value;
            });
            // Convert the JSON object to a string
            const jsonString = JSON.stringify(jsonObject, null, 2);
            const response = await axios.get( ojdServiceEndpoint +"/keyword_to_skills", {
                timeout: 25000,
                params: {
                    keywords: jsonString
                }
            });
            let skills = response.data.skills;

            let collection = skills[0]
            let skilled = collection['SKILL']
            //key=generating keyword, value= (skill, skill code) parsing!

            res.json({ "skills": skilled });

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
    else if(engine === "GPT3.5"){
        try {
            // Create a new instance of Axios for each request
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
    const document = req.query.document;
    const engine = req.query.engine;
    console.log(engine)
    console.log(keywords)

    if(!skillsEngines.includes(engine)){
        console.log("Unsupported engine");
        res.status(500).send({
            message: `Response: unsupported engine}`
        });
    }
    if(engine === "OJD_DAPS") {
        try {
            console.log(keyBertServiceCallerEndpoint)
            // Create a new instance of Axios for each request

            const response = await axios.get( ojdServiceEndpoint +"/keyword_to_skills", {
                timeout: 25000,
                params: {
                    keywords: document
                }
            });
            let skills = response.data.skills;

            console.log("received result"+document)
            res.json({ "skills": skills });
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
