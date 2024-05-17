const express = require('express');
const axios = require('axios'); //promise based HTTP client
const outPort = 13000;

const app = express(); //init app with express
const sparqlEndpoint = 'https://yago-knowledge.org/sparql/query';

// Ensure that the first letter is uppercase and the rest are lowercase, eg coCa cola to Coca Cola
// needed to work fast and without label search on YAGO, but matching the concept directly
function capitalizeFirstLetterAfterSpace(inputString) {
    // Split the inputString by spaces
    const words = inputString.split(" ");

    // Capitalize the first letter of each word
    const capitalizedWords = words.map(word => {
        return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    });

    // Join the capitalized words back together with spaces
    return capitalizedWords.join(" ");
}

//we need to access yago concepts directly, or the service is too slow if we want to do a search matching a label,
//we will in the function call return a list of yago concept that correspond to an
//alternate name for said concept, for which we will do subsequent queries
function generateYagoTermsListQuery(searchTerm) {
    searchTerm = capitalizeFirstLetterAfterSpace(searchTerm);
    return `
        PREFIX schema: <http://schema.org/>
        PREFIX yago: <http://yago-knowledge.org/resource/>
        PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
        PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
       
        SELECT DISTINCT ?yagoConcept
        WHERE {
          ?yagoConcept schema:alternateName "${searchTerm}"@en .
        }
    `;
}

function generateUpperHierarchyQuery(searchTerm) {
    return `
        PREFIX yago: <http://yago-knowledge.org/resource/>
        PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
        PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>

        SELECT DISTINCT ?higherConcept
        WHERE {
          yago:${searchTerm} ?relation ?relatedConcept .
          ?relatedConcept rdfs:subClassOf+ ?higherConcept .
        }
    `;
}

function generateSameLevelHierarchyQuery(searchTerm) {
    return `
        PREFIX schema: <http://schema.org/>
        PREFIX yago: <http://yago-knowledge.org/resource/> 
        PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
        PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
        
        SELECT DISTINCT ?relatedConcept 
        WHERE {
          yago:${searchTerm} ?relation ?relatedConcept .
          FILTER (lang(?relatedConcept) = "en") 
        }
    `;
}



app.use(express.json());

/*app.post('/api', async (req, res) => {
    const response = await axios.post('https://some-api.com', req.body);
    res.json(response.data);
});
*/

//route 1
app.get('/', (req, res) => {
    res.sendStatus(200)
})

//route 2
app.post('/', (req, res) => {
    const {name, location} = req.body
    res.status(200).send({
        message: `Your keys were ${name}, ${location}`
    })
})

//Get upper level in hierarchy concepts
// eg: Bitcoin - > Blockchain
app.get('/queryUpperHierarchy', async (req, res) => {
    try {
        //phase 1: get yago concepts from schema:alternate name
        const response1 = await axios.get(sparqlEndpoint, {
            timeout: 5000, // Set a timeout of 30 seconds
            params: {
                query: generateYagoTermsListQuery(req.query.element)
            }, headers: {
                'Accept': 'application/sparql-results+json'
            }
        })
        // Assuming `response` is the object containing the data you want to expand

        const bindings1 = response1.data.results.bindings;
        console.log(bindings1)

        const results1 = []
        // Iterate through each binding object
        for (const binding of bindings1) {
            // Access the nested `relatedConcept` object
            const relatedConceptObject = binding.yagoConcept.value;
            const parts = relatedConceptObject.split("/"); // Split the Yago Concept URL by '/'
            const lastPart = parts[parts.length - 1];
            results1.push(lastPart);
        }
        console.log(results1)
        const finalResults = []
        for(let i=0; i<results1.length;i++) {
            //second phase
            const response = await axios.get(sparqlEndpoint, {
                timeout: 5000, // Set a timeout of 30 seconds
                params: {
                    query: generateUpperHierarchyQuery(results1[i])
                }, headers: {
                    'Accept': 'application/sparql-results+json'
                }
            })
            // Assuming `response` is the object containing the data you want to expand
            const bindings = response.data.results.bindings;
            // Iterate through each binding object
            for (const binding of bindings) {
                // Access the nested `relatedConcept` object
                const relatedConceptObject = binding.higherConcept.value;
                const parts = relatedConceptObject.split("/"); // Split the Yago Concept URL by '/'
                const lastPart = parts[parts.length - 1];
                finalResults.push(lastPart);
            }
        }
        res.status(200).json({
            results: finalResults
        })
    } catch (err) {
        if (err.code === 'ECONNABORTED') {
            console.log("Request timed out")
            res.status(502).send({
                message: `Response: YAGO service endpoint timed out}`
            })

        } else {
            console.log(err.message)
            res.status(500).send({
                message: `Unknown error in sending request to YAGO service endpoint`
            })
        }
    }
})

//Get same level in hierarchy concepts
// eg: Bitcoin - > digital cash system and associated currency, bitcoin, BTC, ₿, Bitcoins, XBT ..
app.get('/querySameLevelHierarchy', async (req, res) => {
    try {
        console.log(req)
        // Get YAGO concepts from schema:alternate name
        const response1 = await axios.get(sparqlEndpoint, {
            timeout: 5000,
            params: {
                query: generateYagoTermsListQuery(req.query.element)
            },
            headers: {
                'Accept': 'application/sparql-results+json'
            }
        });

        const bindings1 = response1.data.results.bindings;
        const results1 = [];
        for (const binding of bindings1) {
            const relatedConceptObject = binding.yagoConcept.value;
            const parts = relatedConceptObject.split("/");
            const lastPart = parts[parts.length - 1];
            results1.push(lastPart);
        }

        const finalResults = [];
        for (let i = 0; i < results1.length; i++) {
            const response = await axios.get(sparqlEndpoint, {
                timeout: 5000,
                params: {
                    query: generateSameLevelHierarchyQuery(results1[i])
                },
                headers: {
                    'Accept': 'application/sparql-results+json'
                }
            });

            const bindings = response.data.results.bindings;
            for (const binding of bindings) {
                const relatedConceptObject = binding.relatedConcept.value;
                const parts = relatedConceptObject.split("/");
                const lastPart = parts[parts.length - 1];
                finalResults.push(lastPart);
            }
        }

        res.status(200).json({
            results: finalResults
        });
    } catch (err) {
        if (err.code === 'ECONNABORTED') {
            console.log("Request timed out");
            res.status(502).send({
                message: `Response: YAGO service endpoint timed out}`
            });
        } else {
            console.log(err.message);
            res.status(500).send({
                message: `Unknown error in sending request to YAGO service endpoint`
            });
        }
    }
});

app.listen(outPort, () => console.log(`Server running on port: ${outPort}`));
