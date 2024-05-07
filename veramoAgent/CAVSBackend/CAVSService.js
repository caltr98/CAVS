const express = require('express');
const cors = require('cors');
const fs = require('fs');
const axios = require('axios')
const {json} = require("express");
const bodyParser = require("body-parser");
const outPort = 4200;
const app = express();
let keywordExtractorEngines = []
let enricherEngines = ["NONE"]
let skillExtractorEngines = []
// Initial values for extractor and enricher engines

let selectedExtractorEngine = '';
let selectedEnricherEngine = 'NONE';
let selectedSkillExtractorEngine = '';

const config = require('./config.json');

app.use(cors(),express.json());

const serviceKeywordsEndpoint = config.serviceKeywordsEndpoint
const serviceSkillsEndpoint = config.serviceSkillsEndpoint



const configureApp = async () => {
    try {

        let response = await axios.get(`${serviceKeywordsEndpoint}/api_extractor`);
        let data = response.data;
        console.log(data)
        if (data.extractor_engines.length !== 0) {
            // Set the skill extractor engines and the selected skill extractor engine
            keywordExtractorEngines = data.extractor_engines;
            selectedExtractorEngine = data.extractor_engines[0];
        }

        response = await axios.get(`${serviceKeywordsEndpoint}/api_enricher`);
        data = response.data;
        if (data.enricher_engines.length !== 0) {
            // Set the skill extractor engines and the selected skill extractor engine
            enricherEngines = ['NONE'];
            enricherEngines.push(...data.enricher_engines);
            selectedEnricherEngine = enricherEngines[0];
        }


        response = await axios.get(`${serviceSkillsEndpoint}/api_skills`);
        data = response.data;
        if (data.skills_engines.length !== 0) {
            // Set the skill extractor engines and the selected skill extractor engine
            skillExtractorEngines = data.skills_engines;
            selectedSkillExtractorEngine = data.skills_engines[0];
        }




    } catch (error) {
        console.error('Error fetching data:', error);
    }
};


// Route to update selected engines
app.post('/set_api', (req, res) => {

    const extractorEngine = req.body.extractorEngine
    const enricherEngine = req.body.enricherEngine
    const skillExtractorEngine = req.body.skillExtractorEngine

    // Update selected extractor engine if provided
    if (extractorEngine) {
        selectedExtractorEngine = extractorEngine;
    }

    // Update selected enricher engine if provided
    if (enricherEngine) {
        selectedEnricherEngine = enricherEngine;
    }

    // Update selected enricher engine if provided
    if (skillExtractorEngine) {
        selectedSkillExtractorEngine = skillExtractorEngine;
    }

    res.json({
        selectedExtractorEngine,
        selectedEnricherEngine, selectedSkillExtractorEngine
    });
});

//ROUTE 1 get available extractors
app.get("/api_extractor", (req, res) => {
    console.log(`App listening on port${outPort}`)
    res.json({ "extractor_engines": keywordExtractorEngines })
});

//ROUTE 2 get available enricher
app.get("/api_enricher", (req, res) => {
    console.log(`App listening on port${outPort}` + "enrichers"+enricherEngines)
    res.json({ "enricher_engines": enricherEngines })
});

//ROUTE 3 get available skills extractors
app.get("/api_skills", (req, res) => {
    console.log(`App listening on port${outPort}`)
    res.json({ "skills_engines": skillExtractorEngines })
});




//Keyword extraction method
const extractKeywords = async (document, res) => {
    if (!keywordExtractorEngines.includes(selectedExtractorEngine)) {
        console.log("Unsupported engine");
        return {
            status: 500,
            message: `Response: unsupported engine}`
        };
    }

    try {
        console.log("Service caller endpoint: " + serviceKeywordsEndpoint);

        let response = await axios.get(`${serviceKeywordsEndpoint}/extract`, {
            timeout : 65000,
            params: {
                document: document,
                engine: selectedExtractorEngine
            }
        });
        console.log(response.data)
        let keywords = response.data.keyword;
        console.log("Received result: " + keywords);
        return { status: 200, keywords: keywords };
    } catch (err) {
        if (err.code === 'ECONNABORTED') {
            console.log("Request timed out");
            return {
                status: 502,
                message: `Response: service endpoint timed out}`
            };
        } else {
            console.log(err.message);
            return {
                status: 500,
                message: `Unknown error in sending request to service endpoint: ${err.message}`
            };
        }
    }
};


const enrichSameLevel = async (keywords, res) => {
    console.log(selectedEnricherEngine);
    console.log(keywords);

    if (!enricherEngines.includes(selectedEnricherEngine)) {
        console.log("Unsupported engine");
        return {
            status: 500,
            message: `Response: unsupported engine}`
        };
    }
    if (selectedEnricherEngine === "NONE") {
        // Return empty list of keywords
        return { status: 200, keywords: [] };
    }

    try {
        console.log("Service caller endpoint: " + serviceKeywordsEndpoint);

        let response = await axios.get(`${serviceKeywordsEndpoint}/enrich_same_level`, {
            timeout: 65000 * keywords.length,
            params: {
                keywords: keywords,
                engine: selectedEnricherEngine
            }
        });
        let extrakeywords = response.data.keyword
        return { status: 200, keywords: extrakeywords };
    } catch (err) {
        if (err.code === 'ECONNABORTED') {
            console.log("Request timed out");
            return {
                status: 502,
                message: `Response: service endpoint timed out}`
            };
        } else {
            console.log(err.message);
            return {
                status: 500,
                message: `Unknown error in sending request to service endpoint`
            };
        }
    }


};


const enrichUpperLevel = async (keywords, res) => {
    if (!enricherEngines.includes(selectedEnricherEngine)) {
        console.log("Unsupported engine");
        return {
            status: 500,
            message: `Response: unsupported engine}`
        };
    }
    if (selectedEnricherEngine === "NONE") {
        // Return empty list of keywords
        return { status: 200, keywords: [] };
    }

    try {
        console.log("Service caller endpoint: " + serviceKeywordsEndpoint);

        let response = await axios.get(`${serviceKeywordsEndpoint}/enrich_upper_level`, {
            timeout: 65000 * keywords.length,
            params: {
                keywords: keywords,
                engine: selectedEnricherEngine
            }
        });
        let extrakeywords = response.data.keyword
        return { status: 200, keywords: extrakeywords };
    } catch (err) {
        if (err.code === 'ECONNABORTED') {
            console.log("Request timed out");
            return {
                status: 502,
                message: `Response: service endpoint timed out}`
            };
        } else {
            console.log(err.message);
            return {
                status: 500,
                message: `Unknown error in sending request to service endpoint`
            };
        }
    }


};

const extractSkills = async (keywords, res) => {
    if(keywords.length === 0){

        return {
            status: 200,
            skills: []
        };

    }
    if (!skillExtractorEngines.includes(selectedSkillExtractorEngine)) {
        console.log("Unsupported engine");
        return {
            status: 500,
            message: `Response: unsupported engine}`
        };
    }

    try {
        console.log("Service caller endpoint: " + serviceKeywordsEndpoint);
        let response = await axios.get(`${serviceSkillsEndpoint}/keyword_to_skills`, {
            timeout: 65000 * keywords.length,
            params: {
                keywords: keywords,
                engine: selectedSkillExtractorEngine
            }
        });
        console.log(response.data)
        let skills = response.data.skills;
        return { status: 200, skills: skills };
    } catch (err) {
        if (err.code === 'ECONNABORTED') {
            console.log("Request timed out");
            return {
                status: 502,
                message: `Response: service endpoint timed out}`
            };
        } else {
            console.log(err.message);
            return {
                status: 500,
                message: `Unknown error in sending request to service endpoint: ${err.message}`
            };
        }
    }
};




//route that extracts from statement Keywords, conditionally also synonymous concepts and higher level ones
// then it finds the skills from the keywords
//furthermore it matches the credentials provided by the user with skills found
// IT VERIFIES THEM
// Then it creates a Statement Verifiable credential
app.post('/api/vc',bodyParser.json(), async (req, res) => {
    const document = req.body.document;

    // Call the extractKeywords function
    let result = await extractKeywords(document);
    if(result.status !==200){ //error
        res.send(result)
    }
    let keywords = result.keywords
    console.log("here res"+result.keywords)
    result = await enrichSameLevel(keywords)
    if(result.status !==200){ //error
        res.send(result)
    }

    let sameLevelKeywords = result.keywords


    result = await enrichUpperLevel(keywords)
    if(result.status !==200){ //error
        res.send(result)
    }
    let upperLevelKeywords = result.keywords

    // Send the appropriate response based on the resultC


    console.log(keywords)
    console.log(sameLevelKeywords+"\n\n")

    console.log(upperLevelKeywords)


    // Call the extractKeywords function
    result = await extractSkills(keywords);
    if(result.status !==200){ //error
        res.send(result)
    }
    let skillsKeywords = result.skills

    console.log("here res"+skillsKeywords)

    result = await extractSkills(sameLevelKeywords)
    if(result.status !==200){ //error
        res.send(result)
    }

    let sameLevelKeywordsSkills = result.skills


    result = await extractSkills(upperLevelKeywords)
    if(result.status !==200){ //error
        res.send(result)
    }
    let upperLevelKeywordsSkills = result.skills

    // Send the appropriate response based on the resultC

    console.log(skillsKeywords)
    console.log(sameLevelKeywordsSkills+"\n\n")

    console.log(upperLevelKeywordsSkills)

    res.send(200, {skills: skillsKeywords} );



});

// Call configureApp before app.listen
configureApp().then(() => {
    // Start the server
    console.log("setupped with selected" + selectedExtractorEngine + " "+selectedEnricherEngine + " "+ selectedSkillExtractorEngine )
    app.listen(outPort, () => {
        console.log(`Server is running on port ${outPort}`);
    });
});
