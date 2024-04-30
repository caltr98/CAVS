import React, {useEffect, useState} from 'react';
import "./App.css";
import config from "./config.json"
import axios from "axios";


function App() {
    const [inputText, setInputText] = useState("");
    const [addressTextProcessor, setAddressTextProcessor] = useState(config.textprocessor);
    const [addressSkillProcessor, setAddressSkillProcessor] = useState(config.skillprocessor);

    const [keywords, setKeywords] = useState([]);

    const [extractorEngines, setExtractorEngines] = useState([]);
    const [selectedEngine, setSelectedEngine] = useState(''); // State to hold the selected engine

    const [enricherEngines, setEnricherEngines] = useState([]);
    const [selectedEnricherEngine, setSelectedEnricherEngine] = useState(''); // State to hold the selected engine

    const [skillExtractorEngines, setSkillExtractorEngines] = useState([])
    const [selectedSkillExtractorEngine, setSelectedSkillExtractorEngine] = useState([])


    const [sameLevelKeywords, setSameLevelKeywords] = useState([]);
    const [upperLevelKeywords, setUpperLevelKeywords] = useState([]);

    const [sameLevelKeywordsskills, setSameLevelKeywordsSkills] = useState([]);
    const [upperLevelKeywordsskills, setUpperLevelKeywordsSkills] = useState([]);

    const [skills, setSkills] = useState([]);

    // Use useEffect for fetching data using the obtained addressTextProcessor
    useEffect(() => {
        if (addressTextProcessor) {
            fetch(addressTextProcessor + "/api_extractor")
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
            fetch(addressTextProcessor + "/api_enricher")
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
    }, [addressTextProcessor]); // Ensure that [addressTextProcessor] is included in the dependency array

    useEffect(() => {
        if (addressSkillProcessor) {
            fetch(addressSkillProcessor + "/api_skills")
                .then(response => response.json())
                .then(data => {
                    if(data.skills_engines.length!==0) {
                        setSkillExtractorEngines(data.skills_engines);
                        setSelectedSkillExtractorEngine(data.skills_engines[0])
                    }
                })
                .catch(error => {
                    console.error('Error fetching data:', error);
                });


        }
    }, [addressSkillProcessor]); // Ensure that [addressTextProcessor] is included in the dependency array


    const processData = async event => {
        if (event.key === 'Enter' || event.type === 'click') {
            console.log("pre request")
                let response = await axios.get(`${addressTextProcessor}/extract`, {
                    timeout : 65000,
                    params: {
                        document: inputText,
                        engine: selectedEngine
                    }
                });
                console.log("post request")

                console.log(response.data)
                setKeywords({keywords: response.data.keyword});
            }

    };


    const processEnrichData = async event => {

        if (event.key === 'Enter' || event.type === 'click') {
            console.log(selectedEnricherEngine)
            if(addressTextProcessor && keywords.keywords) {
                let response = await axios.get(`${addressTextProcessor}/enrich_same_level`, {
                    timeout : 65000*keywords.keywords.length,
                    params: {
                        keywords: keywords.keywords,
                        engine: selectedEnricherEngine
                    }
                });
                console.log(response.data)
                setSameLevelKeywords({keywords: response.data.keyword})
                response = await axios.get(`${addressTextProcessor}/enrich_upper_level`, {
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


    const extractSkills = async event => {

        if (event.type === 'click') {
            console.log(skillExtractorEngines)
            if (addressSkillProcessor && keywords.keywords) {
                let response = await axios.get(`${addressSkillProcessor}/keyword_to_skills`, {
                    timeout: 65000 * keywords.keywords.length,
                    params: {
                        keywords: keywords.keywords,
                        engine: selectedSkillExtractorEngine
                    }
                });
                console.log(response.data)

                setSkills({skills: response.data.skills})
                if (upperLevelKeywords.keywords) {
                    console.log("upper level"+upperLevelKeywords.keywords)
                    let response = await axios.get(`${addressSkillProcessor}/keyword_to_skills`, {
                        timeout: 65000 * upperLevelKeywords.keywords.length,
                        params: {
                            keywords: upperLevelKeywords.keywords,
                            engine: selectedSkillExtractorEngine
                        }
                    });
                    console.log(response.data)

                    setUpperLevelKeywordsSkills({skills: response.data.skills})
                }
                if (sameLevelKeywords.keywords) {
                    console.log("upper level"+sameLevelKeywords.keywords)
                    let response = await axios.get(`${addressSkillProcessor}/keyword_to_skills`, {
                        timeout: 65000 * sameLevelKeywords.keywords.length,
                        params: {
                            keywords: upperLevelKeywords.keywords,
                            engine: selectedSkillExtractorEngine
                        }
                    });
                    console.log(response.data)

                    setSameLevelKeywordsSkills({skills: response.data.skills})
                }

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
            <div className="extractor-engines-data">
                <p className="title-extractor-engines-data">Skill Extractor Engines:</p>
                <select
                    className="extractor-engines-select"
                    value={selectedSkillExtractorEngine}
                    onChange={(e) => setSelectedSkillExtractorEngine(e.target.value)}
                >
                    {skillExtractorEngines.map((engine, i) => (
                        <option key={i} value={engine}>
                            {engine}
                        </option>
                    ))}
                </select>
            </div>
            <button className="process-button" onClick={extractSkills}>Extract Skills</button>
            {!skills.skills ? (
                <div>
                    <p>Get Skills!</p>
                </div>
            ) : (
                <div className="keywords-data">
                    <p className="title-keywords-data">
                        Skills extracted:
                    </p>
                    <ul className="keywords-list">
                        {skills.skills.map((skill, i) => (
                            <ul key={i} className="keywords-list-item">
                                <li><span
                                    style={{color: 'blue', backgroundColor: 'lightgrey'}}>Keyword: </span>{skill[0]}
                                </li>
                                <li><span
                                    style={{color: 'blue', backgroundColor: 'lightgrey'}}>Skill: </span> {skill[1][0]}
                                </li>
                                <li><span
                                    style={{color: 'blue', backgroundColor: 'lightgrey'}}>Skill Code: </span> {skill[1][1]}
                                </li>

                            </ul>
                        ))}
                    </ul>
                </div>
            )}
            {!sameLevelKeywordsskills.skills ? (
                <div>
                    <p>Get Skills for synonymous!</p>
                </div>
            ) : (
                <div className="keywords-data">
                    <p className="title-keywords-data">
                        Skills extracted for synonymous:
                    </p>
                    <ul className="keywords-list">
                        {sameLevelKeywordsskills.skills.map((skill, i) => (
                            <ul key={i} className="keywords-list-item">
                                <li><span
                                    style={{color: 'blue', backgroundColor: 'lightgrey'}}>Keyword: </span>{skill[0]}
                                </li>
                                <li><span
                                    style={{color: 'blue', backgroundColor: 'lightgrey'}}>Skill: </span> {skill[1][0]}
                                </li>
                                <li><span
                                    style={{color: 'blue', backgroundColor: 'lightgrey'}}>Skill Code: </span> {skill[1][1]}
                                </li>

                            </ul>
                        ))}
                    </ul>
                </div>
            )}
            {!upperLevelKeywordsskills.skills ? (
                <div>
                    <p>Get Skills for more general context</p>
                </div>
            ) : (
                <div className="keywords-data">
                    <p className="title-keywords-data">
                        Skills extracted for more general context:
                    </p>
                    <ul className="keywords-list">
                        {upperLevelKeywordsskills.skills.map((skill, i) => (
                            <ul key={i} className="keywords-list-item">
                                <li><span
                                    style={{color: 'blue', backgroundColor: 'lightgrey'}}>Keyword: </span>{skill[0]}
                                </li>
                                <li><span
                                    style={{color: 'blue', backgroundColor: 'lightgrey'}}>Skill: </span> {skill[1][0]}
                                </li>
                                <li><span
                                    style={{color: 'blue', backgroundColor: 'lightgrey'}}>Skill Code: </span> {skill[1][1]}
                                </li>

                            </ul>
                        ))}
                    </ul>
                </div>
            )}


        </div>
    );

}

export default App;
