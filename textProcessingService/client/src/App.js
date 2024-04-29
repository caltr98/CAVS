import React, {useEffect, useState} from 'react';
import "./App.css";
import axios from "axios";

function App() {
    const [inputText, setInputText] = useState("");
    const [address, setAddress] = useState("");
    const [keywords, setKeywords] = useState([]);
    const [extractorEngines, setExtractorEngines] = useState([]);
    const [selectedEngine, setSelectedEngine] = useState(''); // State to hold the selected engine
    const [enricherEngines, setEnricherEngines] = useState([]);
    const [selectedEnricherEngine, setSelectedEnricherEngine] = useState(''); // State to hold the selected engine

    const [sameLevelKeywords, setSameLevelKeywords] = useState([]);
    const [upperLevelKeywords, setUpperLevelKeywords] = useState([]);
    // Use useEffect for fetching configuration asynchronously
    useEffect(() => {
        fetch("/config.json") // Assuming the JSON file is in the public folder
            .then(response => response.json()) // Parse the JSON response
            .then(data => {
                setAddress(data.address); // Get the address from the JSON data
            })
            .catch(error => {
                console.error('Error fetching or parsing address:', error.message);
            });
    }, []);

    // Use useEffect for fetching data using the obtained address
    useEffect(() => {
        if (address) {
            fetch(address + "/api_extractor")
                .then(response => response.json())
                .then(data => {
                    if(data.extractor_engines.length!==0) {
                        setExtractorEngines(data.extractor_engines);
                        setSelectedEngine(data.extractor_engines[0])
                    }
                })
                .catch(error => {
                    console.error('Error fetching data:', error);
                });
            fetch(address + "/api_enricher")
                .then(response => response.json())
                .then(data => {
                    if(data.enricher_engines.length!==0) {
                        setEnricherEngines(data.enricher_engines);
                        setSelectedEnricherEngine(data.enricher_engines[0])
                    }
                })
                .catch(error => {
                    console.error('Error fetching data:', error);
                });

        }
    }, [address]); // Ensure that [address] is included in the dependency array



    const processData = async event => {
        if (event.key === 'Enter' || event.type === 'click') {
            console.log(selectedEngine)
            if(address) {
                let response = await axios.get(address+"/extract", {
                    timeout : 65000,
                    params: {
                        document: inputText,
                        engine: selectedEngine
                    }
                });
                console.log(response.data)
                setKeywords({keywords: response.data.keyword});
            }
        }
    };


    const processEnrichData = async event => {

        if (event.key === 'Enter' || event.type === 'click') {
            console.log(selectedEngine)
            if(address && keywords.keywords) {
                let response = await axios.get(address+"/enrich_same_level", {
                    timeout : 65000*keywords.keywords.length,
                    params: {
                        keywords: keywords.keywords,
                        engine: selectedEnricherEngine
                    }
                });
                console.log(response.data)
                setSameLevelKeywords({keywords: response.data.keyword})
                response = await axios.get(address+"/enrich_upper_level", {
                    timeout : 65000*keywords.keywords.length,
                    params: {
                        keywords: keywords.keywords,
                        engine: selectedEnricherEngine
                    }
                });
                console.log(response.data)
                setUpperLevelKeywords({keywords: response.data.keyword})

            }
        }
    };

    return (
        <div className="container">
            {extractorEngines.length === 0 ? (
                <div>
                    <p>Loading</p>
                </div>
            ) : (
                <div className="extractor-engines-data">
                    <p className="title-extractor-engines-data">Extractor Engines:</p>
                    <select
                        className="extractor-engines-select"
                        value={selectedEngine}
                        onChange={(e) => setSelectedEngine(e.target.value)}
                    >
                        {extractorEngines.map((engine, i) => (
                            <option key={i} value={engine}>
                                {engine}
                            </option>
                        ))}
                    </select>
                </div>
            )}

            <
                textarea
                className="input"
                placeholder="Enter Text..."
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                onKeyPress={processData}
            />
            <button className="process-button" onClick={processData}>Extract</button>

            {!keywords.keywords ? (
                <div>
                    <p>Welcome to keywords extractor app!</p>
                </div>
            ) : (
                <div className="keywords-data">
                    <p className="title-keywords-data">
                        Keywords extracted:
                    </p>
                    <ul className="keywords-list">
                        {keywords.keywords.map((keyword, i) => (
                            <li key={i} className="keywords-list-item">{keyword}</li>
                        ))}
                    </ul>
                </div>
            )}
            <div className="extractor-engines-data">
                <p className="title-extractor-engines-data">Enricher Engines:</p>
                <select
                    className="extractor-engines-select"
                    value={selectedEnricherEngine}
                    onChange={(e) => setSelectedEnricherEngine(e.target.value)}
                >
                    {enricherEngines.map((engine, i) => (
                        <option key={i} value={engine}>
                            {engine}
                        </option>
                    ))}
                </select>
            </div>
            <button className="process-button" onClick={processEnrichData}>Enrich</button>
            {!sameLevelKeywords.keywords ? (
                <div>
                    <p>Get Same level keywords!</p>
                </div>
            ) : (
                <div className="keywords-data">
                    <p className="title-keywords-data">
                        Same level Keywords extracted:
                    </p>
                    <ul className="keywords-list">
                        {sameLevelKeywords.keywords.map((keyword, i) => (
                            <li key={i} className="keywords-list-item">{keyword}</li>
                        ))}
                    </ul>
                </div>
            )}
            {!upperLevelKeywords.keywords ? (
                <div>
                    <p>Get Upper level keywords!</p>
                </div>
            ) : (
                <div className="keywords-data">
                    <p className="title-keywords-data">
                        Upper level Keywords extracted:
                    </p>
                    <ul className="keywords-list">
                        {upperLevelKeywords.keywords.map((keyword, i) => (
                            <li key={i} className="keywords-list-item">{keyword}</li>
                        ))}
                    </ul>
                </div>
            )}


        </div>
    );
}

export default App;
