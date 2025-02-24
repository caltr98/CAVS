import express from 'express';
import cors from 'cors';
import axios from 'axios';
import bodyParser from 'body-parser';
import fs from 'fs';
import path from 'path';
import config from './config.json' assert {type: 'json'};
import trustedissuers from './trustedissuers.json' assert {type: 'json'};

const app = express();
const outPort = 4200;
const PORT = 17005;

let keywordExtractorEngines = [];
let enricherEngines = ['NONE'];
let skillExtractorEngines = [];

let selectedExtractorEngine = '';
let selectedEnricherEngine = 'NONE';
let selectedSkillExtractorEngine = '';
const selectedDIDETHAWalletAddr = '0x877545E3910550Ce27c2c51Bd2FF14837acB6566';
const selectedDIDPrivKey = 'f55a62b189423bf293d3e9b8bbd114d98bd28b29fc45d07d4876ce2f2dc51440';
let selectedDID = '';

const serviceKeywordsEndpoint = config.serviceKeywordsEndpoint;
const serviceSkillsEndpoint = config.serviceSkillsEndpoint;
const veramoAgentEndpoint = config.veramoAgentEndpoint;

let selectiveDisclosureMode = true;

let selectiveDisclousureRequests = {};
app.use(cors(), express.json());

async function fetchDIDWithRetry() {
    while (!selectedDID) {
        try {
            const response = await axios.get(
                `${veramoAgentEndpoint}/api/v0/setup/?privatekey=${selectedDIDPrivKey}&walletaddr=${selectedDIDETHAWalletAddr}`,
                {
                    timeout: 65000,
                }
            );
            selectedDID = response.data.did;
            console.log('Our DID:', selectedDID);
        } catch (error) {
            console.error('Error fetching credentials:', error.message);
            await new Promise((resolve) => setTimeout(resolve, 5000)); // wait for 5 seconds before retrying
        }
    }
}

const configureApp = async () => {
    try {
        await fetchDIDWithRetry();

        let response = await axios.get(`${serviceKeywordsEndpoint}/api_extractor`);
        let data = response.data;
        console.log(data);
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
            skillExtractorEngines = data.skills_engines;
            selectedSkillExtractorEngine = data.skills_engines[0];
        }

    } catch (error) {
        console.error('Error fetching data:', error);
    }
};

// Additional route and function definitions...

app.post('/set_api', (req, res) => {
    const extractorEngine = req.body.extractorEngine;
    const enricherEngine = req.body.enricherEngine;
    const skillExtractorEngine = req.body.skillExtractorEngine;
    const requestedSelectiveDisclosureMode = req.body.selectiveDisclosureMode;

    if (extractorEngine) {
        selectedExtractorEngine = extractorEngine;
    }
    if (enricherEngine) {
        selectedEnricherEngine = enricherEngine;
    }
    if (skillExtractorEngine) {
        selectedSkillExtractorEngine = skillExtractorEngine;
    }

    selectiveDisclosureMode = requestedSelectiveDisclosureMode === "true";


    res.json({
        selectedExtractorEngine,
        selectedEnricherEngine,
        selectedSkillExtractorEngine,
        selectiveDisclosureMode
    });
});

//ROUTE 1 get available extractors
app.get("/api_extractor", (req, res) => {
    console.log(`App listening on port ${outPort}`);
    res.json({"extractor_engines": keywordExtractorEngines});
});

//ROUTE 2 get available enricher
app.get("/api_enricher", (req, res) => {
    console.log(`App listening on port ${outPort}` + " enrichers " + enricherEngines);
    res.json({"enricher_engines": enricherEngines});
});

//ROUTE 3 get available skills extractors
app.get("/api_skills", (req, res) => {
    console.log(`App listening on port ${outPort}`);
    res.json({"skills_engines": skillExtractorEngines});
});





// ROUTE 4 set DID as new Selected DID
app.post("/setup_did", async (req, res) => {
    try {
        const response = await axios.get(`${veramoAgentEndpoint}/create_did`, {
            timeout: 65000,
        });
        selectedDID = response.data.did;
        console.log("DID: " + response.data.did);
        res.status(200).send({"did": response.data.did});
    } catch (error) {
        console.error("Error creating DID:", error.message);
        res.status(500).send("Failed to create DID");

    }
});

//ROUTE 5 selective disclosure mode
app.get("/api_selective_disclosure_mode", (req, res) => {
    console.log(`App listening on port ${outPort}`);
    res.json({"selectiveDisclosureMode": selectiveDisclosureMode});
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
            timeout: 65000,
            params: {
                document: document,
                engine: selectedExtractorEngine
            }
        });
        console.log(response.data)
        let keywords = response.data.keyword;
        console.log("Received result: " + keywords);
        return {status: 200, keywords: keywords, model: response.data.model};
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
        return {status: 200, keywords: []};
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
        return {status: 200, keywords: extrakeywords};
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
        return {status: 200, keywords: []};
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
        return {status: 200, keywords: extrakeywords};
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
    if (keywords.length === 0) {

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
        return {status: 200, skills: skills, model: response.data.model};
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


function checkSkillAgainstKeywords(skill, skillsKeywords) {
    for (let k = 0; k < skillsKeywords.length; k++) {
        console.log("Checking skill against keywords" + skill + " " + skillsKeywords[k][0]);


        if (skill[0] === skillsKeywords[k][0]) {
            console.log("match");
            return true;
        }
    }
    return false;
}


app.post('/api/issuer_trust', bodyParser.json(), async (req, res) => {
    const {did, rank} = req.body;

    if (!did) {
        res.status(500).send({error: 'DID is missing'});

    }
    if (!rank || rank > 5 || rank < 0) {
        res.status(500).send({error: 'rank must be between 0 and 5'});
    }

    // Append the new object to the array
    trustedissuers.push({did: did, rank: rank});

    // Save the updated array back to the JSON file
    const filePath = path.resolve('./trustedissuers.json');
    fs.writeFileSync(filePath, JSON.stringify(trustedissuers, null, 2));

    res.send("ok");
});

//route that extracts from statement Keywords, conditionally also synonymous concepts and higher level ones
// then it finds the skills from the keywords
//furthermore it matches the credentials provided by the user with skills found
// IT VERIFIES THEM
// Then it creates a Statement Verifiable credential
app.post('/api/vc', bodyParser.json(), async (req, res) => {
    try {


        const document = req.body.document;
        const credentials = req.body.credentials;
        const typeStatement = req.body.typeStatement;
        const category = req.body.category;
        const statementTitle = req.body.statementTitle;
        const holderDID = req.body.holderDID;

        let result;
        if(!selectiveDisclosureMode) {
            result = await processVerificationDataNonSelectiveDisclousure(document, credentials, holderDID);
        }

        else {
            result = await selectiveDisclosureRequest(document, holderDID);
        }
        res.status(result.status).send(result.data);
    } catch (error) {
        res.status(500).send("Failed to create Verifiable Credential");
    }
});

async function selectiveDisclosureRequest(document, holderDID) {
    let result = await extractKeywords(document);
    if (result.status !== 200) return { status: result.status, data: result };
    let keywords = result.keywords;
    let concepts_keywords_model = result.model;

    result = await extractSkills(keywords);
    if (result.status !== 200) return { status: result.status, data: result };
    let skillsKeywords = parseSkills(result.skills);
    let skills_model = result.model;


    let selectiveDisclosureRequest = {
        "holder": holderDID,
        "skills_extracted": skillsKeywords,
        "keywords_to_skills_extracted":result.skills,
        "skills_model": skills_model,
        "concepts_keywords_model": concepts_keywords_model,
    }


    selectiveDisclousureRequests[holderDID] = selectiveDisclosureRequest;
    console.log("Selective Disclosure "+ JSON.stringify(selectiveDisclousureRequests[holderDID],null,2));
    return { status: 200, data: { selectiveDisclosureRequest: selectiveDisclosureRequest } };

}

app.post('/api/vc/selective_disclosure_issuing', bodyParser.json(), async (req, res) => {
    const holderDID = req.body.holderDID;
    const vp = req.body.vp;
    const attributes = vp.attributes;
    const verifiableCredentials = vp.verifiableCredential;

    console.log(vp.attributes)

    if (!selectiveDisclousureRequests[holderDID]) {
        return res.status(404).send("Selective Disclosure Request not found");
    }


    console.log(selectiveDisclousureRequests[holderDID])
    let skill;
    let skillsPossessed = [];
    let skillName = "";
    console.log(selectiveDisclousureRequests[holderDID].skills_extracted.length)
    for (skill of selectiveDisclousureRequests[holderDID].skills_extracted) {
        skillName = skill[0];
        for (let attribute of attributes) {
            console.log("Checking skill against attribute" + skillName + " " + attribute.clearValue);
            let attributeName = attribute.clearValue.split("|")[0];
            if (skillName === attributeName) {
                skillsPossessed.push(attribute.clearValue);
            }
        }
    }

    if(skillsPossessed.length === 0){
        return res.status(404).send("No skills found in the provided credentials");

    }
    let response_verification_correctness;
    try{
        response_verification_correctness = await axios.post(`${veramoAgentEndpoint}/verify/vp/selective_disclosure_correctness`, {vp: vp},{
            headers: { 'Content-Type': 'application/json' },
            timeout: 65000
        })
    }catch (error) {
        return { status: 500, data: "Failed to verify correctness of VP Selective Disclosure" };
    }

    console.log(response_verification_correctness)

    if(response_verification_correctness["verificationRES"] === false){
        res.status(200).send("Wrong Verification Result for Selective Disclosure");
        return;
    }

    let verification_vp;
    try{
        verification_vp = await axios.post(`${veramoAgentEndpoint}/verify/vp`, {vp: vp,did: holderDID},{
            headers: { 'Content-Type': 'application/json' },
            timeout: 65000
        })
    }catch (error) {
        return { status: 500, data: "Failed to verify of VP" };
    }
    console.log("verification: "+verification_vp.data["res"])
    if(verification_vp.data["res"] === false){
        res.status(200).send("False VP for Selective Disclosure");
        return;
    }

    let keywordsCredentials = [];
    let keywordsCredentialsRanks = [];

    for(let verifiableCredential of verifiableCredentials){
        if(!await verify_VC(verifiableCredential)){
            res.status(200).send("verifiableCredential from issuer is false",verifiableCredential.issuer.id);
            return;
        }
        let rank = getCredentialRank(verifiableCredential.issuer.id);
        keywordsCredentials.push(verifiableCredential);
        keywordsCredentialsRanks.push(rank);

    }



    console.log("Issuing Statement Verifiable Credential");
    try {

        let response_issuing = await axios.post(
            `${veramoAgentEndpoint}/issue_verifiable_credential`,
            {
                issuer: selectedDID,
                holder: holderDID,
                type: "StatementVerifiableCredential",
                attributes: {
                    cavs_config: selectedExtractorEngine + "+" + selectedEnricherEngine + "+" + selectedSkillExtractorEngine,
                    keywords_model: selectiveDisclousureRequests[holderDID].concepts_keywords_model,
                    skills_model: selectiveDisclousureRequests[holderDID].skills_model,
                    skills_possessed: skillsPossessed,
                    ranks_for_skills: keywordsCredentialsRanks,
                    extracted_skills: selectiveDisclousureRequests[holderDID].skills_extracted,
                    keywords_to_skills_extracted: selectiveDisclousureRequests[holderDID].keywords_to_skills_extracted
                },
                store: false
            },
            {
                headers: { 'Content-Type': 'application/json' },
                timeout: 650000
            }
        );
        console.log("After issuing Statement Verifiable Credential");
        console.log(response_issuing.data)
        return res.status(200).send({jwt: response_issuing.data.jwt});
    } catch (error) {
        console.log("Failed at Statement Verifiable Credential");
        return res.status(500).send("Failed to create Verifiable Credential");
    }
});

async function processVerificationDataNonSelectiveDisclousure(document, credentials, holderDID) {
    let result = await extractKeywords(document);
    if (result.status !== 200) return { status: result.status, data: result };
    let keywords = result.keywords;
    let keywordsModel = result.model;

    result = await enrichSameLevel(keywords);
    if (result.status !== 200) return { status: result.status, data: result };
    let sameLevelKeywords = result.keywords;
    let sameLevelKeywordsModel = result.model;

    result = await enrichUpperLevel(keywords);
    if (result.status !== 200) return { status: result.status, data: result };
    let upperLevelKeywords = result.keywords;
    let upperLevelKeywordsModel = result.model;

    result = await extractSkills(keywords);
    if (result.status !== 200) return { status: result.status, data: result };
    let skillsKeywords = parseSkills(result.skills);
    let skillsModel = result.model;

    result = await extractSkills(sameLevelKeywords);
    if (result.status !== 200) return { status: result.status, data: result };
    let sameLevelKeywordsSkills = parseSkills(result.skills);

    result = await extractSkills(upperLevelKeywords);
    if (result.status !== 200) return { status: result.status, data: result };
    let upperLevelKeywordsSkills = parseSkills(result.skills);

    let extracted_keywords_to_skills = [];
    let sameLevelMatchedSkills = [];
    let upperLevelMatchedSkills = [];

    let keywordsCredentialsRanks = [];
    let sameLevelKeywordsCredentialsRanks = [];
    let upperLevelKeywordsCredentialsRanks = [];

    for (let cred of credentials) {
        let { skills, id } = cred.credentialSubject;

        if (id === holderDID && verify_VC(cred)) {
            let rank = getCredentialRank(cred.issuer.id);

            let matchedKeywords = skillsKeywords.filter(keyword =>
                skills.some(skill => checkSkillAgainstKeywords(skill, [keyword]))
            );
            let matchedSameLevelKeywords = sameLevelKeywordsSkills.filter(keyword =>
                skills.some(skill => checkSkillAgainstKeywords(skill, [keyword]))
            );
            let matchedUpperLevelKeywords = upperLevelKeywordsSkills.filter(keyword =>
                skills.some(skill => checkSkillAgainstKeywords(skill, [keyword]))
            );

            if (matchedKeywords.length > 0) {
                extracted_keywords_to_skills.push(...matchedKeywords);
                keywordsCredentialsRanks.push(rank);
            }
            if (matchedSameLevelKeywords.length > 0) {
                sameLevelMatchedSkills.push(...matchedSameLevelKeywords);
                sameLevelKeywordsCredentialsRanks.push(rank);
            }
            if (matchedUpperLevelKeywords.length > 0) {
                upperLevelMatchedSkills.push(...matchedUpperLevelKeywords);
                upperLevelKeywordsCredentialsRanks.push(rank);
            }
        }
    }

    console.log("Issuing Statement Verifiable Credential");
    try {
        const response = await axios.post(
            `${veramoAgentEndpoint}/issue_verifiable_credential`,
            {
                issuer: selectedDID,
                holder: holderDID,
                type: "StatementVerifiableCredential",
                attributes: {
                    cavs_config: selectedExtractorEngine + "+" + selectedEnricherEngine + "+" + selectedSkillExtractorEngine,
                    keywords,
                    keywords_model: keywordsModel,
                    skills_model: skillsModel,
                    skills: skillsKeywords,
                    similar_concepts_keywords: sameLevelKeywords,
                    similar_concepts_keywords_model: sameLevelKeywordsModel,
                    ranks_for_skills: keywordsCredentialsRanks,
                    matched_skills: extracted_keywords_to_skills,
                    matched_similar_concepts_skills: sameLevelMatchedSkills,
                    matched_general_concepts_skills: upperLevelMatchedSkills,
                    ranks_for_similar_concepts_skills: sameLevelKeywordsCredentialsRanks,
                    ranks_for_general_concepts_skills: upperLevelKeywordsCredentialsRanks
                },
                store: false
            },
            {
                headers: { 'Content-Type': 'application/json' },
                timeout: 65000
            }
        );

        return { status: 200, data: { jwt: response.data.jwt } };
    } catch (error) {
        return { status: 500, data: "Failed to create Verifiable Credential" };
    }
}


function getCredentialRank(issuerDID) {
    let rank = 0;
    for (let trustedIssuer of trustedissuers) {
        if (trustedIssuer.did === issuerDID) {
            rank = trustedIssuer.rank;
            break;
        }
    }
    return rank;
}



const parseSkills = (skills) => {
    // Create a map to store unique skills
    const uniqueSkillsMap = new Map();

    // Iterate over the skills array
    skills.forEach(([skillTerm, [skillCategory, skillLink]]) => {
        // Check if the skill category already exists in the map
        if (uniqueSkillsMap.has(skillCategory)) {
            // If exists, compare the current link with the existing one and keep the shortest link
            const existingLink = uniqueSkillsMap.get(skillCategory)[1];
            if (skillLink.length < existingLink.length) {
                uniqueSkillsMap.set(skillCategory, [skillCategory, skillLink]);
            }
        } else {
            // If not exists, add the skill category to the map
            uniqueSkillsMap.set(skillCategory, [skillCategory, skillLink]);
        }
    });

    // Convert the map values to an array of unique skills
    const uniqueSkills = Array.from(uniqueSkillsMap.values());

    return uniqueSkills;
};

const verify_VC = async (vc) => {

    let response = await axios.post(
        `${veramoAgentEndpoint}/verify`,
        {
            credential: vc,
        },
        {
            headers: {
                'Content-Type': 'application/json'
            },
            timeout: 65000
        }
    );
    return response.data.res
}


// SIMULATION
//CODE TO USE FOR SIMULATION
app.post('/simulation/skillsfromtext', bodyParser.json(), async (req, res) => {
    try {
        let text = req.body.text;
        console.log("text:", text);

        // Extract keywords from bio
        let text_keywords = await extractKeywords(text);
        if (text_keywords.status !== 200) {
            return res.status(text_keywords.status).send(text_keywords);
        }

        // Extract skills from bio keywords
        let skill_text = await extractSkills(text_keywords.keywords);
        if (skill_text.status !== 200) {
            return res.status(skill_text.status).send(skill_text);
        }

        console.log("Extracted skills from text:", skill_text.skills);

        // Parse the skills
        let skills = parseSkills(skill_text.skills);

        res.send({
            skills: skills
        });

    } catch (error) {
        console.error("Error in /simulation/skillsfromtext:", error);
        res.status(500).send({error: 'Internal Server Error', details: error.message});
    }
});

app.post('/simulation', bodyParser.json(), async (req, res) => {
    try {
        let {document, bio} = req.body;
        console.log("Bio:", bio);

        // Extract keywords from bio
        let bio_keywords = await extractKeywords(bio);
        if (bio_keywords.status !== 200) {
            return res.status(bio_keywords.status).send(bio_keywords);
        }

        // Extract skills from bio keywords
        let skill_bio = await extractSkills(bio_keywords.keywords);
        if (skill_bio.status !== 200) {
            return res.status(skill_bio.status).send(skill_bio);
        }

        console.log("Extracted skills from bio:", skill_bio.skills);

        // Parse the skills
        let skills = parseSkills(skill_bio.skills);

        // Extract keywords from document
        let doc_keywords = await extractKeywords(document);
        if (doc_keywords.status !== 200) {
            return res.status(doc_keywords.status).send(doc_keywords);
        }

        // Extract skills from document keywords
        let doc_skills = await extractSkills(doc_keywords.keywords);
        if (doc_skills.status !== 200) {
            return res.status(doc_skills.status).send(doc_skills);
        }

        console.log("Extracted skills from document:", doc_skills.skills);

        // Parse the skills from document
        let skillsKeywords = parseSkills(doc_skills.skills);

        console.log("Skills keywords from document:", skillsKeywords);

        // Match skills
        let keywordsMatch = 0;

        for (let skill of skills) {
            let isKeywordMatch = checkSkillAgainstKeywords(skill, skillsKeywords);

            if (isKeywordMatch) {
                keywordsMatch++;
            }
        }

        res.send({
            matches: keywordsMatch
        });

    } catch (error) {
        console.error("Error in /simulation:", error);
        res.status(500).send({error: 'Internal Server Error', details: error.message});
    }
});

// Call configureApp before app.listen
configureApp().then(() => {
    // Start the server
    console.log("attention Setup completed with selected engines: " + selectedExtractorEngine + " " + selectedEnricherEngine + " " + selectedSkillExtractorEngine + " " + selectedDID);
    app.listen(outPort, () => {
        console.log(`Server is running on port ${outPort}`);
    });
});




