import React, {useEffect, useState} from 'react';
import "./App.css";
import config from "./config.json"
import secret from "./secret.json"
import axios from "axios";
import {FileUploader} from "react-drag-drop-files";
import sjcl from 'sjcl'

function App() {

    const roles = ["CertificateIssuer", "CAVS", "AuthorHolder", "Spreader", "ReaderVerifier"]
    const [selectedRole, setSelectedRole] = useState("CertificateIssuer")

    const [addressVeramoAgent] = useState(config.veramoagent);
    const [addressIPFSAgent] = useState(config.ipfsagent);


    const [peerIDIPFS, setPeerIDIPFS] = useState('')
    const [addressTextProcessor] = useState(config.textprocessor);
    const [addressSkillProcessor] = useState(config.skillprocessor);

    const [firstCAVSAddress] = useState(config.cavsendpoint);
    const [secondCAVSAddress] = useState(config.cavsendpoint2);
    const [thirdCAVSAddress] = useState(config.cavsendpoint3);

    const [addressCAVS, setAddressCAVS] = useState("");

    const [dids, setDids] = useState([]);
    const [selectedDid, setSelectedDid] = useState(config.veramoagent);


    const [image, setImage] = useState("")
    const [verifiableCredentialHash1, setVerifiableCredentialHash1] = useState("")
    const [ethrPrivKey, setEthrPrivKey] = useState('')
    const [ethrAddr, setEthrAddr] = useState('')
    const [opFeedback, setOpFeedback] = useState('Ready to Add')


// Load IPFS PeerID
    useEffect(() => {
        fetch(`${addressIPFSAgent}/set_secrets?name=${secret.name}&psw=${secret.password}`)
            .then(response => {
                if (!response.ok) {
                    throw new Error('Failed to set secrets on IPFS agent');
                }
                // If the set_secrets request is successful, fetch the PeerID
                return fetch(`${addressIPFSAgent}/peer_id`);
            })
            .then(response => {
                if (!response.ok) {
                    throw new Error('Failed to get PeerID from IPFS agent');
                }
                // If the peer_id request is successful, parse the response body as JSON
                return response.json();
            })
            .then(data => {
                // Access the parsed JSON data and log the PeerID
                console.log('Received PeerID:', data.peer_id);
                // Do whatever you want with the PeerID, like setting it in state
                setPeerIDIPFS(data.peer_id);
            })
            .catch(error => {
                console.error('Error during IPFS PeerID fetch:', error);
            });
    }, [addressIPFSAgent, secret]);

    // Use useEffect for fetching data using the obtained addressVeramoAgent
    useEffect(() => {
        if (addressVeramoAgent) {
            fetch(addressVeramoAgent + "/get_own_did")
                .then(response => response.json())
                .then(data => {
                    if (data.dids.length !== 0) {
                        setDids(data.dids)
                        setSelectedDid(data.dids[0])
                    }
                })
                .catch(error => {
                    console.error('Error fetching data:', error);
                });
        }
    }, [addressVeramoAgent]); // Ensure that [addressVeramoAgent] is included in the dependency array
    // get qr code
    const getQR = async event => {
        console.log("here")
        if (event.type === 'click') {
            if (verifiableCredentialHash1) {
                const response = await axios.post(`${addressVeramoAgent}/get_qr_code/jwt`, {
                    jwt: verifiableCredentialHash1
                }, {
                    responseType: 'arraybuffer', // Set the response type to arraybuffer
                    timeout: 65000
                });

                console.log("post request")
                const base64 = btoa(
                    new Uint8Array(response.data).reduce(
                        (data, byte) => data + String.fromCharCode(byte),
                        ''
                    )
                )
                setImage(base64)

                console.log("hello" + response.data)
            }
        }

    };


    const newDID = async () => {
        try {
            const response = await axios.get(`${addressVeramoAgent}/create_did`, {
                timeout: 65000,
            });
            let newdids = [...dids, response.data.did]
            setDids(newdids) //update list
            setSelectedDid(newdids[0])

        } catch (error) {
            console.error('Error fetching credentials:', error);
        }
    }

    const newDIDEHTR = async () => {
        try {
            const response = await axios.get(`${addressVeramoAgent}/api/v0/setup?privatekey=` + ethrPrivKey + '&walletaddr=' + ethrAddr, {
                timeout: 65000,
            });
            let newdids = [...dids, response.data.did]
            setDids(newdids) //update list
            setSelectedDid(newdids[0])

        } catch (error) {
            console.error('Error fetching credentials:', error);
        }
    }

    const AuthorHolder = () => {
        const [jsonDataVCSkills, setJsonDataVCSkills] = useState('');

        const [jsonDataVCStatement, setjsonDataVCStatement] = useState('');

        const [selectedCredentials, setSelectedCredentials] = useState([]);
        const [selectedSkills, setSelectedSkills] = useState([]);

        const [statementText, setStatementText] = useState("")
        const [CAVSInstanceEndpoint, setCAVSInstanceEndpoint] = useState("")
        const [toSelectiveDisclose, setToSelectiveDisclose] = useState(false);
        const [opFeedback, setOpFeedback] = useState("Ready to Request")
        const [categoryStatement, setCategoryStatement] = useState("")
        const [typeStatement] = useState(["News", "Article", "Rumor", "Comment", "Opinion", "Leak", "Blog", "Post"])
        const [selectedTypeStatement, setSelectedTypeStatement] = useState(typeStatement[0])
        const [skillsToPresent, setSkillsToPresent] = useState([])
        const [listCIDs, setListCIDs] = useState([])


        // Function to handle checkbox selection
        const handleCheckboxChange = (event, index) => {
            console.log(selectedCredentials)
            if (event.target.checked) {
                //insert element
                setSelectedCredentials([...selectedCredentials, index]);
            } else {
                //remove element
                setSelectedCredentials(selectedCredentials.filter(item => item !== index));
            }
        };

        // Function to handle checkbox selection
        const handleCheckboxChangeSkills = (event, index) => {
            console.log(selectedSkills)
            if (event.target.checked) {
                //insert element
                setSelectedSkills([...selectedSkills, index]);
                console.log(selectedSkills)
            } else {
                //remove element
                setSelectedSkills(selectedSkills.filter(item => item !== index));
            }
        };


// Function to fetch credentials
        const sendToCavs = async () => {
            if (CAVSInstanceEndpoint === "") {
                setOpFeedback("Please enter CAVS instance endpoint");
                return;
            }

            let credentials = [];
            console.log(jsonDataVCSkills.at(0));
            for (let i = 0; i < selectedCredentials.length; i++) {
                credentials.push(jsonDataVCSkills.at(selectedCredentials.at(i)).verifiableCredential);
            }
            console.log(credentials);

            setOpFeedback("Processing creation of Statement VC");

            try {
                console.log("selected did is ", selectedDid);

                // Start time for POST request to create the VC statement
                const startTime = new Date();
                console.log(`Posting to api/vc at: ${startTime.toLocaleString()}`);

                // POST request to CAVS to create VC statement
                let response;
                let startRequestTime = new Date();
                response = await axios.post(
                    `${CAVSInstanceEndpoint}/api/vc`,
                    {
                        document: statementText,
                        credentials: credentials,
                        typeStatement: selectedTypeStatement,
                        category: categoryStatement,
                        statementTitle: statementText.substring(0, 30),
                        holderDID: selectedDid,
                    },
                    {
                        headers: {
                            'Content-Type': 'application/json',
                        },
                        timeout: 195000, // 3 minutes timeout
                    }
                );
                const endRequestTime = new Date();
                const timeTakenForCreateStatement = (endRequestTime - startRequestTime) / 1000; // Time in seconds
                console.log(`Time taken for POST request to create VC statement: ${timeTakenForCreateStatement} seconds`);

                const endTime = new Date();
                const timeTakenForApiPost = (endTime - startTime) / 1000; // Time in seconds
                console.log(`Response received at: ${endTime.toLocaleString()}`);
                console.log(`Time taken for POST request: ${timeTakenForApiPost} seconds`);

                console.log(response);

                if (response.data.selectiveDisclosureRequest) {
                    console.log("Selective disclosure request received");

                    // Fetch credentials if selective disclosure request is present
                    await fetchCredentials();
                    setToSelectiveDisclose(true);
                    setSkillsToPresent(response.data.selectiveDisclosureRequest.skills_extracted);
                }

                setOpFeedback("Got VC Statement, storing in wallet of " + selectedDid);

                // Start time for storing the VC credential
                let startStoreTime = new Date();
                response = await axios.post(
                    `${addressVeramoAgent}/store_vc`,
                    {
                        verifiableCredential: response.data.jwt,
                        did: selectedDid,
                    },
                    {
                        headers: {
                            'Content-Type': 'application/json',
                        },
                        timeout: 650000, // 10 minutes timeout
                    }
                );
                const endStoreTime = new Date();
                const timeTakenForStoreVC = (endStoreTime - startStoreTime) / 1000; // Time in seconds
                console.log(`Time taken for storing VC: ${timeTakenForStoreVC} seconds`);

                console.log(response);
                setStatementText("");
                setCategoryStatement("");
                setOpFeedback("Done");

            } catch (error) {
                console.error('Error obtaining credentials:', error);
            }
        };


        const respondToSelectiveDisclosureRequest = async () => {
            if (CAVSInstanceEndpoint === "") {
                setOpFeedback("Please enter CAVS instance endpoint");
                return;
            }

            let credentials = [];
            console.log(jsonDataVCSkills.at(0));
            for (let i = 0; i < selectedCredentials.length; i++) {
                credentials.push(jsonDataVCSkills.at(selectedCredentials.at(i)).hash);
            }
            console.log(credentials);

            let skills = [];
            for (let i = 0; i < selectedSkills.length; i++) {
                skills.push("skill_" + skillsToPresent.at(selectedSkills[i])[0]);
            }

            console.log(skills);

            setOpFeedback("Creating Selective Disclosure Verifiable Presentation");

            let startTime = new Date();
            console.log(`Issuing Verifiable Presentation Disclosure at: ${startTime.toLocaleString()}`);

            // First axios call to issue verifiable presentation
            let response;
            let startRequestTime = new Date();
            try {
                response = await axios.post(
                    `${addressVeramoAgent}/issue_verifiable_presentation/selective_disclosure`,
                    {
                        hashOfVCs: credentials,
                        attributesToDisclose: skills,
                        typeStatement: selectedTypeStatement,
                        toStore: true,
                        type: "VerifiablePresentation",
                        holder: selectedDid,
                    },
                    {
                        headers: {
                            'Content-Type': 'application/json',
                        },
                        timeout: 195000, // 3 minutes timeout
                    }
                );
                const endRequestTime = new Date();
                const timeTakenForIssueVP = (endRequestTime - startRequestTime) / 1000; // in seconds
                console.log(`Time taken to issue Verifiable Presentation: ${timeTakenForIssueVP} seconds`);
            } catch (error) {
                console.error("Error issuing Verifiable Presentation:", error);
                return;
            }

            const endTime = new Date();
            const timeTakenForIssuance = (endTime - startTime) / 1000; // Time in seconds
            console.log(`Total time taken for issuing Verifiable Presentation: ${timeTakenForIssuance} seconds`);

            setOpFeedback("Sending Selective Disclosure VP to CAVS");

            let vpToPresent = response.data.vp;

            let startCavsRequestTime = new Date();
            console.log(`Issuing Verifiable Presentation to CAVS at: ${startCavsRequestTime.toLocaleString()}`);

            // Second axios call to send VP to CAVS
            try {
                response = await axios.post(
                    `${CAVSInstanceEndpoint}/api/vc/selective_disclosure_issuing`,
                    {
                        holderDID: selectedDid,
                        vp: vpToPresent,
                        verifiableCredential: credentials,
                    },
                    {
                        headers: {
                            'Content-Type': 'application/json',
                        },
                        timeout: 195000, // 3 minutes timeout
                    }
                );
                const endCavsRequestTime = new Date();
                const timeTakenForCavsRequest = (endCavsRequestTime - startCavsRequestTime) / 1000; // in seconds
                console.log(`Time taken for CAVS request: ${timeTakenForCavsRequest} seconds`);
            } catch (error) {
                console.error("Error sending Verifiable Presentation to CAVS:", error);
                return;
            }

            console.log("Done and response is " + response);
            setOpFeedback("Got VC Statement, storing in wallet of " + selectedDid);

            // Final axios call to store VC
            try {
                let startStoreTime = new Date();
                response = await axios.post(
                    `${addressVeramoAgent}/store_vc`,
                    {
                        verifiableCredential: response.data.jwt,
                        did: selectedDid,
                    },
                    {
                        headers: {
                            'Content-Type': 'application/json',
                        },
                        timeout: 650000, // 10 minutes timeout
                    }
                );
                const endStoreTime = new Date();
                const timeTakenForStore = (endStoreTime - startStoreTime) / 1000; // in seconds
                console.log(`Time taken for storing VC: ${timeTakenForStore} seconds`);
            } catch (error) {
                console.error("Error storing credentials:", error);
            }

            setStatementText("");
            setCategoryStatement("");
            setOpFeedback("Done");
        };

        const fetchCredentials = async () => {
            try {
                const [response1, response2] = await Promise.all([
                    axios.get(`${addressVeramoAgent}/api/v0/list-verifiable-credentials-with-type`, {
                        timeout: 65000,
                        params: { type: "ESCO_type_VerifiableCredential" }
                    }),
                    axios.get(`${addressVeramoAgent}/api/v0/list-verifiable-credentials-with-type/selective_disclosure`, {
                        timeout: 65000,
                        params: { type: "SelectiveDisclosure_ESCO_type_VerifiableCredential" }
                    })
                ]);
                console.log(response2.data)
                // Merge results
                const mergedData = [...response1.data, ...response2.data];

                setJsonDataVCSkills(mergedData);
            } catch (error) {
                console.error('Error fetching credentials:', error);
            }
        };


        const fetchStatementCredentials = async () => {
            try {
                const response = await axios.get(`${addressVeramoAgent}/api/v0/list-verifiable-credentials-with-type`, {
                    timeout: 65000,
                    params: {
                        type: "StatementVerifiableCredential"
                    }
                });
                setjsonDataVCStatement(response.data);
            } catch (error) {
                console.error('Error fetching credentials:', error);
            }

        };

        const ipfsPublish = async (id) => {
            try {
                let response = await axios.post(
                    `${addressIPFSAgent}/upload`,
                    {
                        //sending jwt
                        text: jsonDataVCStatement[id].verifiableCredential.proof.jwt
                    },
                    {
                        headers: {
                            'Content-Type': 'application/json'
                        },
                        timeout: 65000
                    }
                );

                console.log("received response" + response.data.CID)
                const updatedListCIDs = [...listCIDs]; // Create a copy of the array
                updatedListCIDs[id] = response.data.CID; // Update the value at the specified index
                console.log("id:" + id);
                console.log("updated CID at index " + id + ": " + updatedListCIDs[id]);
                setListCIDs(updatedListCIDs); // Update the state with the new array
            } catch (error) {
                console.error('Error publishing on IPFS or fetching:', error);
            }

        };

        return (
            <div className="dids-data" style={{textAlign: 'center'}}>
                <button className="process-button" onClick={fetchCredentials}>Fetch ESCO Skills Verifiable Credential
                </button>
                {jsonDataVCSkills && toSelectiveDisclose === false && (
                    <div className="credentials-list-container">
                        <p>Select Credentials for VC</p>

                        {jsonDataVCSkills.map((credential, index) => (
                            <div key={index} className="credential">
                                <input
                                    style={{width: '2vw', height: '2vw'}} // Set the width and height
                                    type="checkbox"
                                    checked={selectedCredentials.includes(index)}
                                    onChange={(event) => handleCheckboxChange(event, index)}
                                />
                                <h3>Credential #{index + 1}</h3>
                                <p>Hash: {credential.hash}</p>
                                <p>Issuance Date: {credential.verifiableCredential.issuanceDate}</p>
                                <p>Credential Type: {credential.verifiableCredential.type.join(', ')}</p>
                                <p>Issuer DID: {credential.verifiableCredential.issuer.id}</p>
                                <p>Holder DID: {credential.verifiableCredential.credentialSubject.id}</p>
                                <textarea
                                    readOnly={true}
                                    className="input"
                                    value={JSON.stringify(credential.verifiableCredential.credentialSubject, null, 2)}
                                />
                                {credential.mapping && (
                                    <textarea
                                        readOnly={true}
                                        className="input"
                                        value={JSON.stringify(credential.mapping, null, 2)}
                                    />
                                )}

                            </div>
                        ))}
                        <div>
                            <p>Selected Credentials: {selectedCredentials.length}</p>
                        </div>
                    </div>
                )}
                <label className="form-label" htmlFor="holderURL">Statement Category(Economics, Medicine,
                    Science..)</label>
                <input
                    type="text"
                    className="form-input"
                    id="holderURL"
                    value={categoryStatement}
                    onChange={(e) => setCategoryStatement(e.target.value)}
                />
                <label className="form-label" htmlFor="holderURL">Statement Type:</label>
                <select
                    className="select-box"
                    value={selectedTypeStatement}
                    onChange={(e) => {
                        setSelectedTypeStatement(e.target.value);
                    }}
                >
                    {typeStatement.map((typeS, i) => (
                        <option key={i} value={typeS}>
                            {typeS}
                        </option>
                    ))}
                </select>

                <label className="form-label" htmlFor="holderURL">Statement:</label>

                <textarea
                    className="form-input-area"
                    placeholder="Enter Statement"
                    value={statementText}
                    onChange={(e) => setStatementText(e.target.value)}
                />

                <h3>Choose CAVS instance endpoint, preset ones: http://localhost:4200, http://localhost:4202,
                    http://localhost:4203</h3>
                <textarea
                    type="text"
                    className="form-input"
                    id="instanceEndpoint"
                    placeholder="Enter CAVS instance endpoint"
                    value={CAVSInstanceEndpoint}
                    onChange={(e) => setCAVSInstanceEndpoint(e.target.value)}
                />

                <button className="process-button" onClick={sendToCavs}>Send to CAVS
                </button>

                {skillsToPresent && toSelectiveDisclose === true && (
                    <div className="credentials-list-container">
                        <p>Select Skills for VC</p>

                        {skillsToPresent.map((keywordToSkill, index) => (
                            <div key={index} className="credential">
                                <input
                                    style={{width: '2vw', height: '2vw'}} // Set the width and height
                                    type="checkbox"
                                    checked={selectedSkills.includes(index)}
                                    onChange={(event) => handleCheckboxChangeSkills(event, index)}
                                />
                                <h3>Skill #{index + 1}</h3>
                                <p>Skill Name: {keywordToSkill[0]}</p>
                                <p>Skill URI: {keywordToSkill[1]}</p>
                            </div>
                        ))}
                        <div>
                            <p>Selected Credentials: {selectedCredentials.length}</p>
                        </div>
                    </div>
                )}

                {jsonDataVCSkills && toSelectiveDisclose === true && (
                    <div className="credentials-list-container">
                        <p>Select Credentials for VC</p>

                        {jsonDataVCSkills.map((credential, index) => (
                            <div key={index} className="credential">
                                <input
                                    style={{width: '2vw', height: '2vw'}} // Set the width and height
                                    type="checkbox"
                                    checked={selectedCredentials.includes(index)}
                                    onChange={(event) => handleCheckboxChange(event, index)}
                                />
                                <h3>Credential #{index + 1}</h3>
                                <p>Hash: {credential.hash}</p>
                                <p>Issuance Date: {credential.verifiableCredential.issuanceDate}</p>
                                <p>Credential Type: {credential.verifiableCredential.type.join(', ')}</p>
                                <p>Issuer DID: {credential.verifiableCredential.issuer.id}</p>
                                <p>Holder DID: {credential.verifiableCredential.credentialSubject.id}</p>
                                <textarea
                                    readOnly={true}
                                    className="input"
                                    value={JSON.stringify(credential.verifiableCredential.credentialSubject, null, 2)}
                                />
                                {credential.mapping && (
                                    <textarea
                                        readOnly={true}
                                        className="input"
                                        value={JSON.stringify(credential.mapping, null, 2)}
                                    />
                                )}

                            </div>
                        ))}
                        <div>
                            <p>Selected Credentials: {selectedCredentials.length}</p>
                        </div>
                    </div>

                )}

                {toSelectiveDisclose === true && (
                <button className="process-button" onClick={respondToSelectiveDisclosureRequest}>Send Selective
                    Disclosure Request
                </button>
                )}
                <p className="feedback-text">{opFeedback}</p>
                <div></div>
                <button className="process-button" onClick={fetchStatementCredentials}> Fetch
                    StatementVerifiableCredentials
                </button>

                {jsonDataVCStatement && (
                    <div className="credentials-list-container">
                        {jsonDataVCStatement.map((credential, index) => (
                            <div key={index} className="credential">


                                <button className="process-button" onClick={() => ipfsPublish(index)}> Publish/Get on
                                    IPFS
                                </button>

                                <h3>Credential #{index + 1}</h3>
                                {listCIDs[index] ? (
                                    <h3>CID is defined: {listCIDs[index]}</h3>
                                ) : (
                                    <h3>CID is unkwown</h3>
                                )}
                                <p>Hash: {credential.hash}</p>
                                <p>Issuance Date: {credential.verifiableCredential.issuanceDate}</p>
                                <p>Credential Type: {credential.verifiableCredential.type.join(', ')}</p>
                                <p>Issuer DID: {credential.verifiableCredential.issuer.id}</p>
                                <p>Holder DID: {credential.verifiableCredential.credentialSubject.id}</p>
                                <textarea
                                    readOnly={true}
                                    className="input"
                                    value={JSON.stringify(credential.verifiableCredential.credentialSubject, null, 2)}
                                />
                            </div>
                        ))}
                    </div>

                )}
                <Spreader/>


            </div>
        );
    };


    const Spreader = () => {
        const [hostURLPresentation, setHostURLPresentation] = useState('');
        const [selectedTypePresentation, setSelectedTypePresentation] = useState('Origin');
        const [cidOfStatementVC, setCidOfStatementVC] = useState('');
        const [prevUUID, setPrevUUID] = useState('')
        const [prevJWT, setPrevJWT] = useState('')
        const [listOfCIDsOfStatementVC, setListOfCIDsOfStatementVC] = useState([])
        const [opFeedback, setOpFeedback] = useState('Ready To Create')
        const [jwtGot, setJwtGot] = useState('')

        const typePresentation = ["Origin", "Diffusion"]; // Define your array of presentation types
        const [textOfStatement, setTextOfStatement] = useState("")
        const [jsonVPsSharing, setJsonVPsSharing] = useState([])
        // Function to calculate hash
        const calculateHash = (text) => {
            const bitArray = sjcl.hash.sha256.hash(text);
            return sjcl.codec.hex.fromBits(bitArray);
        };


        const createPresentationOrigin = async () => {
            if (textOfStatement && selectedTypePresentation && listOfCIDsOfStatementVC.length > 0) {

                const hashOfStatement = calculateHash(textOfStatement); // Calculate hash of statement
                console.log("Hash of Statement:", hashOfStatement);
                try {

                    let response = await axios.post(`${addressVeramoAgent}/issue_verifiable_presentation/holder_claim`, {
                        holder: selectedDid,
                        type: "StatementSharing_VP",
                        attributes: (
                            {
                                statement_vc_cid_list: listOfCIDsOfStatementVC,
                                hashing_algo: "sha256",
                                hash_of_statement: hashOfStatement,
                                prev_vp_uuid: "",//jwt of prev_vp, empty if origin
                                url_or_cid_jwt_prev: "",
                                type: "origin",//first presentation that refers to statement vc, else diffusion
                                host_URL: hostURLPresentation
                            }
                        ),
                        assertion: "This VP is submitted by the subject as evidence of VC propagation",
                        store: true //store it too
                    }, {
                        headers: {
                            'Content-Type': 'application/json'
                        }, timeout: 65000
                    });
                    console.log("post request")
                    console.log(response.data.jwt)
                    setOpFeedback("Created VP, below jwt")
                    setJwtGot(response.data.jwt)
                } catch (error) {
                    setOpFeedback("Error occurres")
                }
            } else {
                setOpFeedback("Omitted Field/s")

            }
        };

        const createPresentationSharing = async () => {
            if (hostURLPresentation && selectedTypePresentation && cidOfStatementVC && prevUUID) {
                try {
                    setOpFeedback("Loading previous VP obtained to IPFS with own PeerID");

                    let obj = {};
                    obj[prevUUID] = prevJWT;
                    let text = JSON.stringify(obj);

                    let response = await axios.post(`${addressIPFSAgent}/upload`, {
                        text: text //store mapping between UUID of prev and its JWT
                    }, {
                        headers: {
                            'Content-Type': 'application/json'
                        }, timeout: 120000 //2 minutes fair limit
                    });
                    let cid = (response.data.CID)

                    console.log("here is the cid" + cid)

                    setOpFeedback("Done loading previous VP, creating new VP");

                    response = await axios.post(`${addressVeramoAgent}/issue_verifiable_presentation/holder_claim`, {
                        holder: selectedDid,
                        type: "StatementSharing_VP",
                        attributes: (
                            {
                                statement_vc_cid_list: cidOfStatementVC,
                                prev_vp_uuid: prevUUID,//jwt of prev_vp, empty if origin
                                url_or_cid_jwt_prev: cid,
                                type: "diffusion",//first presentation that refers to statement vc, else diffusion,
                                host_URL: hostURLPresentation
                            }
                        ),
                        assertion: "This VP is submitted by the subject as evidence of VC propagation",
                        store: true //store it too
                    }, {
                        headers: {
                            'Content-Type': 'application/json'
                        }, timeout: 65000
                    });
                    console.log("post request")
                    console.log(response.data.jwt)
                    setOpFeedback("Created VP, below jwt")
                    setJwtGot(response.data.jwt)
                } catch (error) {
                    setOpFeedback("Error occurres")
                }
            } else {
                setOpFeedback("Omitted Field/s")

            }
        };

        const fetchVerifiablePresentations = async () => {
            try {
                const response = await axios.get(`${addressVeramoAgent}/list_verifiable_presentations_with_type`, {
                    timeout: 65000,
                    params: {
                        type: "StatementSharing_VP"
                    }
                });
                console.log(response.data)
                setJsonVPsSharing(response.data);
            } catch (error) {
                console.error('Error fetching credentials:', error);
            }

        };

        function addCidOfStatementVC() {
            if (cidOfStatementVC !== "") {
                if (!listOfCIDsOfStatementVC.includes(cidOfStatementVC)) {
                    setListOfCIDsOfStatementVC((prevList) => [...prevList, cidOfStatementVC]);
                    setOpFeedback("Added CID of Statement Verifiable Credential/s");

                }

                setCidOfStatementVC("");
            }
        }

        return (<div className="dids-data" style={{align: 'center', textAlign: 'center', width: '57vw'}}>
            <p className="form-label">PeerID on IPFS:{peerIDIPFS}</p>
            <p className="title-dids-data">Create Sharing Verifiable Presentation:</p>
            <label className="form-label" htmlFor="holderURL">Presentation Host URL</label>
            <input
                type="text"
                className="form-input"
                id="holderURL"
                value={hostURLPresentation}
                onChange={(e) => setHostURLPresentation(e.target.value)}
            />
            <label className="form-label" htmlFor="holderURL">Statement Text for Hashing</label>

            <input
                type="text"
                className="form-input"
                id="textOfStatement"
                value={textOfStatement}
                onChange={(e) => setTextOfStatement(e.target.value)}
            />

            <label className="form-label" htmlFor="holderURL">Presentation Type:</label>
            <select
                className="select-box"
                value={selectedTypePresentation}
                onChange={(e) => {
                    setSelectedTypePresentation(e.target.value);
                }}
            >
                {typePresentation.map((typeP, i) => (<option key={i} value={typeP}>
                    {typeP}
                </option>))}
            </select>

            {(selectedTypePresentation === 'Origin' || selectedTypePresentation === 'Diffusion') && (<div>
                <label className="form-label" htmlFor="holderURL">CID of Statement Verifiable Credential</label>
                <input
                    type="text"
                    className="form-input"
                    id="cidStatement"
                    value={cidOfStatementVC}
                    onChange={(e) => setCidOfStatementVC(e.target.value)}
                />


                )
                {selectedTypePresentation === 'Origin' && (
                    <div>
                        <button className="process-button" onClick={addCidOfStatementVC}>
                            Add CID of Statement Verifiable Credential
                        </button>
                        <div> -</div>
                        <button className="process-button" onClick={createPresentationOrigin}>
                            Create Origin Presentation
                        </button>
                    </div>
                )}
            </div>)
            }
            {
                selectedTypePresentation === 'Diffusion' && (<div>
                    <label className="form-label" htmlFor="holderURL">UUID of Previous Presentation</label>
                    <input
                        type="text"
                        className="form-input"
                        id="uuidPrev"
                        value={prevUUID}
                        onChange={(e) => setPrevUUID(e.target.value)}
                    />
                    <label className="form-label" htmlFor="holderURL">JWT of Previous Presentation</label>
                    <input
                        type="text"
                        className="form-input"
                        id="uuidPrev"
                        value={prevJWT}
                        onChange={(e) => setPrevJWT(e.target.value)}
                    />

                    <button className="process-button" onClick={createPresentationSharing}>Create Sharing
                        Presentation
                    </button>
                </div>)}
            <p className="feedback-text">{opFeedback}</p>
            {jwtGot && (
                <textarea
                    className="jwt-textarea"
                    style={{overflowX: 'auto', width: '100%', minHeight: '100px'}}
                    value={jwtGot}
                    readOnly
                />
            )}
            <button className="process-button" onClick={fetchVerifiablePresentations}>Fetch Sharing VP</button>
            {jsonVPsSharing.map((presentation, index) => (
                    <div key={index} className="credential">
                        <h3>Sharing VP #{index + 1}</h3>
                        <p>Type: {presentation.verifiablePresentation.attributes.type}</p> {/* Type from Credential Subject */}
                        <p>Issuance
                            Date: {presentation.verifiablePresentation.issuanceDate}</p> {/* Issuance Date from VP */}
                        <h3 style={{overflowX: 'auto', width: '100%', minHeight: 'auto'}}>UUID of
                            VP: {presentation.verifiablePresentation.id}</h3> {/* UUID from Issuer DID */}
                        <h3 style={{overflowX: 'auto', width: '100%', minHeight: 'auto'}}>URL or CID on IPFS of prev JWT
                            URL: {presentation.verifiablePresentation.attributes.url_or_cid_jwt_prev}</h3> {/* vc_statement_cid_or_url */}
                        <h3 style={{overflowX: 'auto', width: '100%', minHeight: 'auto'}}>Hash of statement
                            URL: {presentation.verifiablePresentation.attributes.hash_of_statement}</h3> {/* vc_statement_cid_or_url */}
                        <h3 style={{overflowX: 'auto', width: '100%', minHeight: 'auto'}}>Hashing algorithm for
                            reproducibility
                            URL: {presentation.verifiablePresentation.attributes.hashing_algo}</h3> {/* vc_statement_cid_or_url */}
                        <h3 style={{overflowX: 'auto', width: '100%', minHeight: 'auto'}}>
                            VC statement CID or URL:
                            {presentation?.verifiablePresentation?.attributes?.statement_vc_cid_list?.length > 0 ? (
                                presentation.verifiablePresentation.attributes.statement_vc_cid_list.map((cid, index) => (
                                    <div key={index}>
                                        {index + 1}. {cid}
                                    </div>
                                ))
                            ) : (
                                <div>No CIDs available</div>
                            )}
                        </h3>
                        <p style={{overflowX: 'auto', width: '100%', minHeight: 'auto'}}>Holder
                            DID: {presentation.verifiablePresentation.holder}</p> {/* Holder DID */}
                        <p style={{overflowX: 'auto', width: '100%', minHeight: 'auto'}}>Host
                            URL: {presentation.verifiablePresentation.attributes.host_URL}</p> {/* HostURL */}
                        <p style={{overflowX: 'auto', width: '100%', minHeight: 'auto'}}>Prev
                            UUID: {presentation.verifiablePresentation.attributes.prev_vp_uuid}</p>

                        <h3>JWT of Sharing VP #{index + 1} for next Sharing VP</h3>

                        <textarea
                            className="jwt-textarea"
                            style={{overflowX: 'auto', width: '90%', minHeight: '100px'}}
                            value={presentation.verifiablePresentation.proof.jwt}
                            readOnly/>


                    </div>
                )
            )}
            {jsonVPsSharing.length > 0 && (
                <textarea
                    className="jwt-textarea"
                    style={{overflowX: 'auto', width: '100%', height: '10vw'}}
                    value={JSON.stringify(jsonVPsSharing, null, 2)}
                    readOnly
                />
            )}


        </div>);
    };


    const CertificateIssuerForm = () => {
        const [holderDID, setHolderDID] = useState('');
        const [holderURL, setHolderURL] = useState('');
        const [certificateText, setCertificateText] = useState('');
        const [skillName, setSkillName] = useState('');
        const [skillUri, setSkillUri] = useState('');
        const [skillCount,setSkillCount] = useState(0);
        const [skills, setSkills] = useState({})
        const [opFeedback, setOpFeedback] = useState('Ready to Create Credential');

        const [extractorEngines, setExtractorEngines] = useState([]);
        const [selectedEngine, setSelectedEngine] = useState(''); // State to hold the selected engine

        const [, setEnricherEngines] = useState([]);
        const [, setSelectedEnricherEngine] = useState(''); // State to hold the selected engine

        const [skillExtractorEngines, setSkillExtractorEngines] = useState([])
        const [selectedSkillExtractorEngine, setSelectedSkillExtractorEngine] = useState([])



        useEffect(() => {
            if (addressSkillProcessor) {
                fetch(addressSkillProcessor + "/api_skills")
                    .then(response => response.json())
                    .then(data => {
                        if (data.skills_engines.length !== 0) {
                            setSkillExtractorEngines(data.skills_engines);
                            setSelectedSkillExtractorEngine(data.skills_engines[0])
                        }
                    })
                    .catch(error => {
                        console.error('Error fetching data:', error);
                    });


            }
        }, [addressSkillProcessor]); // Ensure that [addressTextProcessor] is included in the dependency array


        // Use useEffect for fetching data using the obtained addressTextProcessor
        useEffect(() => {
            if (addressTextProcessor) {
                fetch(addressTextProcessor + "/api_extractor")
                    .then(response => response.json())
                    .then(data => {
                        if (data.extractor_engines.length !== 0) {
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
                        if (data.enricher_engines.length !== 0) {
                            setEnricherEngines(data.enricher_engines);
                            setSelectedEnricherEngine(data.enricher_engines[0])
                        }
                    })
                    .catch(error => {
                        console.error('Error fetching data:', error);
                    });
            }
        }, [addressTextProcessor]); // Ensure that [addressTextProcessor] is included in the dependency array

        async function extractSkillsAndAdd() {
            let response = await axios.get(`${addressTextProcessor}/extract`, {
                timeout: 65000, params: {
                    document: certificateText, engine: selectedEngine
                }
            });
            setOpFeedback("Extracted keywords, extracting skills");

            let currentKeywords = { keywords: response.data.keyword };

            console.log(currentKeywords);
            if (addressSkillProcessor && currentKeywords.keywords) {
                let response = await axios.get(`${addressSkillProcessor}/keyword_to_skills`, {
                    timeout: 65000 * currentKeywords.keywords.length, params: {
                        keywords: currentKeywords.keywords, engine: selectedSkillExtractorEngine
                    }
                });
                console.log(response.data);

                let skillPairs = response.data.skills.map(skill => [skill[1][0], skill[1][1]]);
                console.log("skills pairs", skillPairs);
                // Loop over each skill pair and add them one by one
                skillPairs.forEach(([skillName, skillUri]) => {
                    let counter = skillCount + 1; // Increment the skill counter
                    let newSkill = { [`skill_${skillName}`]: `${skillName}|${skillUri}` };

                    setSkills(prevSkills => ({ ...prevSkills, ...newSkill })); // Add new skill to skills state
                    setSkillCount(counter); // Update skill count
                });

                setOpFeedback("Ready to Create Credential");
            }
        }

        function addSkill() {
            let counter = skillCount + 1; // Increment counter
            let newSkill = { [`skill_${skillName}`]: `${skillName} ${skillUri}` };
            setSkills(prevSkills => ({ ...prevSkills, ...newSkill }));
            setSkillCount(counter); // Update skill count
            setSkillName("");
            setSkillUri("");
        }

        //send credential issue request
        // Send credential issue request
        const issueCredential = async event => {
            if ((event.key === 'Enter' || event.type === 'click') && holderURL && holderURL && skills) {
                if (selectedDid && holderDID && skills) {
                    console.log("pre request" + selectedDid + " holder " + holderDID);

                    // Start time for POST request to issue the credential
                    const startIssueTime = new Date();
                    console.log(`Issuing credential at: ${startIssueTime.toLocaleString()}`);

                    let response;
                    try {
                        // First POST request to issue the verifiable credential
                        response = await axios.post(`${addressVeramoAgent}/issue_verifiable_credential`, {
                            issuer: selectedDid,
                            holder: holderDID,
                            type: "ESCO_type_VerifiableCredential",
                            attributes: { skills: skills },
                            store: false
                        }, {
                            headers: {
                                'Content-Type': 'application/json',
                            },
                            timeout: 65000, // 65 seconds timeout
                        });

                        const endIssueTime = new Date();
                        const timeTakenForIssueCredential = (endIssueTime - startIssueTime) / 1000; // Time in seconds
                        console.log(`Time taken for issuing credential: ${timeTakenForIssueCredential} seconds`);

                        console.log("Post request completed");
                        console.log(response);

                        setOpFeedback("Created Credential, sending to Holder");

                        // Start time for POST request to store the credential in the holder's wallet
                        const startStoreTime = new Date();
                        console.log(`Sending credential to holder at: ${startStoreTime.toLocaleString()}`);

                        // Second POST request to send the credential to the holder
                        response = await axios.post(`${holderURL}/store_vc`, {
                            verifiableCredential: response.data.jwt,
                            did: holderDID,
                        }, {
                            headers: {
                                'Content-Type': 'application/json',
                            },
                            timeout: 650000, // 10 minutes timeout
                        });

                        const endStoreTime = new Date();
                        const timeTakenForStoreCredential = (endStoreTime - startStoreTime) / 1000; // Time in seconds
                        console.log(`Time taken for storing credential in holder's wallet: ${timeTakenForStoreCredential} seconds`);

                        console.log(response);
                        setSkills([]);
                        setOpFeedback("Created Credential, create another");
                    } catch (error) {
                        console.error('Error issuing credential or storing in holder:', error);
                        setOpFeedback("Error occurred, please check the console.");
                    }
                } else {
                    setOpFeedback("Omitted Field/s");
                }
            }
        };




        //send credential issue request
// Issue credential for selective disclosure
        const issueCredentialForSelectiveDisclosure = async event => {
            if ((event.key === 'Enter' || event.type === 'click') && holderURL && holderURL && skills) {
                if (selectedDid && holderDID && skills) {
                    console.log("pre request" + selectedDid + " holder " + holderDID);

                    // Start time for the first POST request to issue the selective disclosure credential
                    const startIssueTime = new Date();
                    console.log(`Issuing credential for selective disclosure at: ${startIssueTime.toLocaleString()}`);

                    let response;
                    try {
                        // First POST request to issue the selective disclosure verifiable credential
                        response = await axios.post(`${addressVeramoAgent}/issue_verifiable_credential/selective_disclosure`, {
                            issuer: selectedDid,
                            holder: holderDID,
                            type: "SelectiveDisclosure_ESCO_type_VerifiableCredential",
                            attributes: skills,
                            store: false
                        }, {
                            headers: {
                                'Content-Type': 'application/json',
                            },
                            timeout: 8000000, // Timeout set to a large value, adjust if necessary
                        });

                        const endIssueTime = new Date();
                        const timeTakenForIssueCredential = (endIssueTime - startIssueTime) / 1000; // Time in seconds
                        console.log(`Time taken for issuing selective disclosure credential: ${timeTakenForIssueCredential} seconds`);

                        console.log("Post request completed");
                        console.log(response);
                        setOpFeedback("Created Credential, sending to Holder");

                        // Start time for the second POST request to store the credential in the holder's wallet
                        const startStoreTime = new Date();
                        console.log(`Sending selective disclosure credential to holder at: ${startStoreTime.toLocaleString()}`);

                        // Second POST request to send the credential to the holder's wallet
                        response = await axios.post(`${holderURL}/store_vc/selective_disclosure`, {
                            vc: response.data.vc,
                            did: holderDID,
                            map: response.data.map
                        }, {
                            headers: {
                                'Content-Type': 'application/json',
                            },
                            timeout: 650000, // 10 minutes timeout
                        });

                        const endStoreTime = new Date();
                        const timeTakenForStoreCredential = (endStoreTime - startStoreTime) / 1000; // Time in seconds
                        console.log(`Time taken for storing credential in holder's wallet: ${timeTakenForStoreCredential} seconds`);

                        console.log(response);
                        setSkills([]);
                        setOpFeedback("Created Credential, create another");
                    } catch (error) {
                        console.error('Error issuing credential or storing in holder:', error);
                        setOpFeedback("Error occurred, please check the console.");
                    }
                } else {
                    setOpFeedback("Omitted Field/s");
                }
            }
        };


        return (<div className="credential-form">
            <p className="section-title">Issue Certificate Verifiable Credential:</p>
            <div className="form-group">
                <label className="form-label" htmlFor="holderDID">New Holder DID:</label>
                <input
                    type="text"
                    className="form-input"
                    id="holderDID"
                    value={holderDID}
                    onChange={(e) => setHolderDID(e.target.value)}
                />
                <label className="form-label" htmlFor="holderURL">New Holder Endpoint URL:</label>
                <input
                    type="text"
                    className="form-input"
                    id="holderURL"
                    value={holderURL}
                    onChange={(e) => setHolderURL(e.target.value)}
                />
            </div>


            <p className="section-title">Certificate Description To Skills</p>
            <div className="form-group">
                <textarea
                    className="form-input-area"
                    placeholder="Enter Certificate Description..."
                    value={certificateText}
                    onChange={(e) => setCertificateText(e.target.value)}
                />
                <div className="extractor-engines-data">
                    <p className="section-title">Keyword Extractor Engines:</p>
                    <select
                        className="select-box"
                        value={selectedEngine}
                        onChange={(e) => setSelectedEngine(e.target.value)}
                    >
                        {extractorEngines.map((engine, i) => (<option key={i} value={engine}>
                            {engine}
                        </option>))}
                    </select>

                    <p className="section-title">Skill Extractor Engines:</p>
                    <select
                        className="select-box"
                        value={selectedSkillExtractorEngine}
                        onChange={(e) => setSelectedSkillExtractorEngine(e.target.value)}
                    >
                        {skillExtractorEngines.map((engine, i) => (<option key={i} value={engine}>
                            {engine}
                        </option>))}
                    </select>
                    <button className="action-button" onClick={extractSkillsAndAdd}>Extract Skills from Description
                    </button>
                </div>
            </div>

            <p className="section-title">Manual Skills Insertion</p>
            <div className="form-group manual-skills-insertion">
                <div className="skill-form-group">
                    <label className="form-label" htmlFor="skillName">Skill Name:</label>
                    <input
                        type="text"
                        className="form-input"
                        id="skillName"
                        value={skillName}
                        onChange={(e) => setSkillName(e.target.value)}
                    />
                </div>
                <div className="skill-form-group">
                    <label className="form-label" htmlFor="skillUri">Skill URI:</label>
                    <input
                        type="text"
                        className="form-input"
                        id="skillUri"
                        value={skillUri}
                        onChange={(e) => setSkillUri(e.target.value)}
                    />
                    <button className="action-button" onClick={addSkill}>Add Skill</button>
                </div>
            </div>

            <ul className="keywords-list">
                {Object.entries(skills).map(([key, value], i) => {
                    // Split the value into skillName and skillUri
                    const [skillName, skillUri] = value.split(' '); // Assuming they are separated by a space
                    return (
                        <li key={i} className="keywords-list-item">
                            <div>
                                <span style={{ color: 'blue', backgroundColor: 'lightgrey' }}>Skill: </span> {skillName}
                            </div>
                            <div>
                                <span style={{ color: 'blue', backgroundColor: 'lightgrey' }}>Skill URI: </span>
                                <a href={skillUri} target="_blank" rel="noopener noreferrer">
                                    {skillUri}
                                </a>
                            </div>
                            <div>--</div>
                        </li>
                    );
                })}
            </ul>

        <button className="action-button" onClick={issueCredential}>Issue Verifiable Credential</button>
            <ul></ul>
        <button className="action-button" onClick={issueCredentialForSelectiveDisclosure}>Issue Verifiable Credential
            For Selective Disclosure</button>

        <p className="feedback-text">{opFeedback}</p>
    </div>)
        ;
    };


    const CavsComponentPanel = ({}) => {
        const [processingFeedback, setProcessingFeedback] = useState('');
        const [statementVC] = useState('');
        const [trustScore, setTrustScore] = useState(1);
        const [didIssuer, setDIDCertificateIssuer] = useState('');
        const [extractorEngines, setExtractorEngines] = useState([]);
        const [selectedKeywordsEngine, setSelectedKeywordsEngine] = useState(''); // State to hold the selected engine
        const [enricherEngines, setEnricherEngines] = useState([]);
        const [selectedEnricherEngine, setSelectedEnricherEngine] = useState(''); // State to hold the selected engine
        const [skillExtractorEngines, setSkillExtractorEngines] = useState([]);
        const [selectedSkillExtractorEngine, setSelectedSkillExtractorEngine] = useState([]);
        const [selectedEnginesString, setSelectedEnginesString] = useState("");
        const [selectedSelectiveDisclosureMode, setSelectedSelectiveDisclosureMode] = useState(false);
        const [selectedSelectiveDisclosureModes, setSelectedSelectiveDisclosureModes] = useState([true, false]);

        const [changeOP, setChangeOP] = useState("");
        const [addressCAVS, setAddressCAVS] = useState(""); // State for CAVS endpoint
        const [opFeedback, setOpFeedback] = useState("");
        const [didInput, setDidInput] = useState(""); // New state for DID input


        async function sendNewIssuer() {
            if (didIssuer && trustScore) {
                try {
                    setOpFeedback("Sending new issuer to CAVS")
                    const response = await axios.post(
                        `${addressCAVS}/api/issuer_trust`,
                        {
                            did: didIssuer,
                            rank: trustScore
                        }
                    );
                    setOpFeedback("Added Issuer, ready for next")
                } catch (error) {
                    console.error('Error updating config:', error);
                    setOpFeedback("Error updating config");
                }
            }
        }

        useEffect(() => {
            if (addressCAVS) {
                fetch(addressCAVS + "/api_skills")
                    .then(response => response.json())
                    .then(data => {
                        if (data.skills_engines.length !== 0) {
                            setSkillExtractorEngines(data.skills_engines);
                            setSelectedSkillExtractorEngine(data.skills_engines[0]);
                            setChangeOP("yes");
                        }
                    })
                    .catch(error => {
                        console.error('Error fetching data:', error);
                    });
            }
        }, [addressCAVS]);

        useEffect(() => {
            if (addressCAVS) {
                fetch(addressCAVS + "/api_selective_disclosure_mode")
                    .then(response => response.json())
                    .then(data => {
                        if (data) {
                            setSelectedSelectiveDisclosureModes([true, false]);
                            setSelectedSelectiveDisclosureMode(data.selectiveDisclosureMode);
                            setChangeOP("yes");
                        }
                    })
                    .catch(error => {
                        console.error('Error fetching data:', error);
                    });
            }
        }, [addressCAVS]);


        useEffect(() => {
            if (addressCAVS) {
                fetch(addressCAVS + "/api_extractor")
                    .then(response => response.json())
                    .then(data => {
                        if (data.extractor_engines.length !== 0) {
                            setExtractorEngines(data.extractor_engines);
                            setSelectedKeywordsEngine(data.extractor_engines[0]);
                            setChangeOP("yes");
                        }
                    })
                    .catch(error => {
                        console.error('Error fetching data:', error);
                    });
                fetch(addressCAVS + "/api_enricher")
                    .then(response => response.json())
                    .then(data => {
                        if (data.enricher_engines.length !== 0) {
                            setEnricherEngines(data.enricher_engines);
                            setSelectedEnricherEngine(data.enricher_engines[0]);
                        }
                        setChangeOP("yes");
                    })
                    .catch(error => {
                        console.error('Error fetching data:', error);
                    });
            }
        }, [addressCAVS]);

        useEffect(() => {
            setSelectedEnginesString([selectedKeywordsEngine, selectedEnricherEngine, selectedSkillExtractorEngine].join(', '));
            setChangeOP("");
        }, [changeOP === "yes"]);

        const updateConfig = async () => {
            if (addressCAVS) {
                try {

                    console.log("before request",selectedSelectiveDisclosureMode)
                    const response = await axios.post(
                        `${addressCAVS}/set_api`,
                        {
                            extractorEngine: selectedKeywordsEngine,
                            enricherEngine: selectedEnricherEngine,
                            skillExtractorEngine: selectedSkillExtractorEngine,
                            selectiveDisclosureMode: selectedSelectiveDisclosureMode.toString()
                        },
                        {
                            headers: {
                                'Content-Type': 'application/json'
                            },
                            timeout: 65000
                        }
                    );

                    setSelectedEnginesString([response.data.selectedExtractorEngine, response.data.selectedEnricherEngine, response.data.selectedSkillExtractorEngine, response.data.selectiveDisclosureMode].join(', '));
                    console.log(response.data);
                } catch (error) {
                    console.error('Error updating config:', error);
                    setProcessingFeedback("Error updating config");
                }
            } else {
                setProcessingFeedback("Omitted Field/s");
            }
        };

        const setupDID = async () => {
            if (addressCAVS) {
                try {
                    const response = await axios.post(`${addressCAVS}/setup_did`
                    );
                    console.log("DID setup response:", response.data);
                    setProcessingFeedback("DID setup complete, new DID: " + response.data.did);
                } catch (error) {
                    console.error('Error setting up DID:', error);
                    setProcessingFeedback("Error setting up DID");
                }
            } else {
                setProcessingFeedback("Please provide a valid DID and endpoint.");
            }
        };

        return (
            <div className="dids-data">
                <p className="section-title">Configure CAVS at
                    addresses {firstCAVSAddress}, {secondCAVSAddress}, {thirdCAVSAddress}</p>
                <button className="process-button" onClick={setupDID}>
                    Setup a new DID
                </button>

                <div className="form-group">
                    <label className="form-label" htmlFor="cavsEndpoint">CAVS Endpoint:</label>
                    <input
                        type="text"
                        className="form-input"
                        id="cavsEndpoint"
                        value={addressCAVS}
                        onChange={(e) => setAddressCAVS(e.target.value)}
                    />
                </div>

                <div className="extractor-engines-data">
                    <p className="title-extractor-engines-data">Extractor Engines:</p>
                    <select
                        className="extractor-engines-select"
                        value={selectedKeywordsEngine}
                        onChange={(e) => setSelectedKeywordsEngine(e.target.value)}
                    >
                        {extractorEngines.map((engine, i) => (
                            <option key={i} value={engine}>
                                {engine}
                            </option>
                        ))}
                    </select>
                </div>

                <div className="extractor-engines-data">
                    <p className="title-extractor-engines-data">Selective Disclosure Mode:</p>
                    <select
                        className="extractor-engines-select"
                        value={selectedSelectiveDisclosureMode.toString()}
                        onChange={(e) => setSelectedSelectiveDisclosureMode(e.target.value === "true")}
                    >
                        {selectedSelectiveDisclosureModes.map((mode, i) => (
                            <option key={i} value={mode.toString()}>
                                {mode ? "True" : "False"}
                            </option>
                        ))}
                    </select>
                </div>


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

                <button className="process-button" onClick={updateConfig}>
                    Update Config
                </button>
                <p>Current Setup: {processingFeedback} {selectedEnginesString}</p>

                {statementVC && (
                    <textarea
                        readOnly={true}
                        className="input"
                        value={JSON.stringify(statementVC, null, 2)}
                    />
                )}
                <div className="container">
                    <div className="credential-form">
                        <div className="form-group">
                            <label className="form-label" htmlFor="didIssuer">Certificate Issuer DID:</label>
                            <input
                                type="text"
                                className="form-input"
                                id="didIssuer"
                                value={didIssuer}
                                onChange={(e) => setDIDCertificateIssuer(e.target.value)}
                            />
                            <label className="form-label" htmlFor="trustScore">Trust Score [1-5]:</label>
                            <input
                                type="text"
                                className="form-input"
                                id="trustScore"
                                value={trustScore}
                                onChange={(e) => setTrustScore(e.target.value)}
                            />

                            <input
                                type="text"
                                className="form-input"
                                id="trustScore"
                                value={trustScore}
                                onChange={(e) => setTrustScore(e.target.value)}
                            />

                            <button className="process-button" onClick={sendNewIssuer}>Rank Issuer</button>
                            <p className="feedback-text">{opFeedback}</p>
                        </div>
                    </div>
                </div>
            </div>
        );
    };

    const ReaderVerifier = () => {

        //const for reading qr functionality
        //default image loader config https://www.npmjs.com/package/react-drag-drop-files
        const [, setFile] = useState(null);
        const [readData, setReadData] = useState(null)
        const handleChange = (file) => {
            setFile(file);
            //reading from https://www.youtube.com/watch?v=nCf7wb8a4YM
            const reader = new FileReader();
            reader.readAsDataURL(file);
            reader.onload = () => {

                //remove prefix and set
                setReadData(reader.result.replace(/^data:image\/\w+;base64,/, ''));
                //no remove
                //etReadData(reader.result)
                console.log(reader.result)
            }
        };
        const fileTypes = ["PNG"];


        // const for ReaderVerifier


        const [opFeedback, setOpFeedback] = useState('Ready')

        const [inputJWT, setInputJWT] = useState('')
        // Define your array of presentation types

        const [jsonVPsSharing, setJsonVPsSharing] = useState([])

        const [decodedJWT, setDecodedJWT] = useState("")


        const [chainOfVP, setChainOfVP] = useState([])
        const [verifiableCredentialStatement, setVerifiableCredentialStatement] = useState('')

        const [jsonDataVCSkills, setJsonDataVCSkills] = useState([])
        const [jsonDataVCSkills2, setJsonDataVCSkills2] = useState([]);
        const [jsonDataVCSkills3, setJsonDataVCSkills3] = useState([]);


        const [verificationResSkill, setVerificationResSkill] = useState([])
        const [traceLen, setTraceLen] = useState(0)
        const [verificationResSharingVP, setVerificationResSharingVP] = useState([])


        const verify_VC = async (vc) => {
            try {
                const startTime = new Date();
                console.log(`Starting VC verification at: ${startTime.toLocaleString()}`);

                let response = await axios.post(
                    `${addressVeramoAgent}/verify`,
                    {
                        credential: vc,
                    },
                    {
                        headers: {
                            'Content-Type': 'application/json'
                        },
                        timeout: 65000 // 65 seconds timeout
                    }
                );

                const endTime = new Date();
                const timeTaken = (endTime - startTime) / 1000; // Time in seconds
                console.log(`Verification response received at: ${endTime.toLocaleString()}`);
                console.log(`Time taken for VC verification: ${timeTaken} seconds`);

                return response.data.res;

            } catch (error) {
                console.log("Error in verification");
            }
            return "";
        };

        const verifyVPSharing = async (vp, index) => {
            // Make a copy of the verificationResSkill array
            const updatedverificationResSharingVP = [...verificationResSharingVP];
            let verval = await verify_VP(vp);
            console.log(verval)
            // Update the verification result for the specific index
            updatedverificationResSharingVP[index] = (verval.toString());
            console.log(index);
            // Set the updated array as the new state
            setVerificationResSharingVP(updatedverificationResSharingVP);

        }

        const verifySkill = async (cred, index) => {
            // Make a copy of the verificationResSkill array
            const updatedVerificationResSkill = [...verificationResSkill];
            let verval = await verify_VC(cred);
            console.log(verval)
            // Update the verification result for the specific index
            updatedVerificationResSkill[index] = (verval.toString());
            console.log(index);
            // Set the updated array as the new state
            setVerificationResSkill(updatedVerificationResSkill);
        };
        const verify_VP = async (vp) => {
            try {
                let response = await axios.post(
                    `${addressVeramoAgent}/verify/vp`,
                    {
                        vp: vp,
                    },
                    {
                        headers: {
                            'Content-Type': 'application/json'
                        },
                        timeout: 65000
                    }
                );
                return response.data.res

            } catch (error) {
                console.log("error in verification")
            }
            return "";
        }

        const [risVerDecoded, setRisVerDecoded] = useState('')
        const verifyVPDecoded = async (vp) => {
            // Make a copy of the verificationResSkill array
            let verval = await verify_VP(vp);
            console.log(verval)
            // Update the verification result for the specific index
            setRisVerDecoded(verval.toString());
        };
        const [risVC, setRisVC] = useState('')
        const verifyStatementVC = async (vc) => {
            // Start the timer
            const startTime = new Date();
            console.log(`Starting verification at: ${startTime.toLocaleString()}`);

            // Make a copy of the verificationResSkill array
            let verval = await verify_VC(vc);
            console.log(verval);

            // Update the verification result for the specific index
            setRisVC(verval.toString());

            // End the timer
            const endTime = new Date();
            const timeTaken = (endTime - startTime) / 1000; // Time in seconds
            console.log(`Verification completed at: ${endTime.toLocaleString()}`);
            console.log(`Time taken for verifying VC: ${timeTaken} seconds`);
        };


        const fetchVerifiablePresentations = async () => {
            try {
                const response = await axios.get(`${addressVeramoAgent}/list_verifiable_presentations_with_type`, {
                    timeout: 65000,
                    params: {
                        type: "StatementSharing_VP"
                    }
                });

                console.log(response.data)
                setJsonVPsSharing(response.data);
            } catch (error) {
                console.error('Error fetching credentials:', error);
            }

        };

        const decodeJWTVerifiablePresentationsText = async () => {
            if (inputJWT) {
                try {
                    const response = await axios.get(`${addressVeramoAgent}/decode_jwt`, { //TODO
                        timeout: 65000,
                        params: {
                            jwt: inputJWT
                        }
                    });
                    console.log(response.data)
                    setDecodedJWT(response.data)
                    setRisVerDecoded('') //set to unkown
                } catch (error) {
                    console.error('Error fetching credentials:', error);
                    setOpFeedback("Error in decoding jwt")

                }
            } else {
                setOpFeedback("Provide a jwt")
            }


        };

        const decodeJWTVerifiablePresentationsImg = async () => {
            if (!readData) {
                setOpFeedback("Provide a JWT");
                return;
            }

            try {
                const response = await axios.post(
                    `${addressVeramoAgent}/decode_jwt/image`,
                    {img_data: readData},
                    {
                        headers: {
                            'Content-Type': 'application/json'
                        },
                        timeout: 165000
                    }
                );
                console.log(response.data)
                setDecodedJWT(response.data);
            } catch (error) {
                console.error('Error fetching credentials:', error);
                setOpFeedback("Error in decoding JWT");
            }
        };
        //extract from VC
        const fetchSkillsFromVC = async (vc) => {
            if (vc && vc.credentialSubject) {
                setJsonDataVCSkills(vc.credentialSubject.credentials_for_skills);
                setJsonDataVCSkills2(vc.credentialSubject.credentials_for_similar_concepts_skills);
                setJsonDataVCSkills3(vc.credentialSubject.credentials_for_general_concepts_skills);
            }
        };
        const closeSkill = () => {
            setJsonDataVCSkills([])
            setJsonDataVCSkills2([])
            setJsonDataVCSkills2([])

        }
        //trace back from VP diffusion of type diffusion to VP diffusion of type origin and then to VC Statement
        const traceBack = async () => {
            let history = []
            let current, prev, response, jwt_of_prev, VC;
            let i = 0;
            if (!decodedJWT) {
                return
            }
            try {
                setOpFeedback("Tracing back");
                current = decodedJWT;
                while (current) { //current will be assigned null when its time to stop
                    response = await axios.get(`${addressIPFSAgent}/retrieve`, {
                        timeout: 120000, //2 min wait max
                        params: {
                            cid: current.attributes.url_or_cid_jwt_prev
                        }
                    });
                    console.log("result got" + JSON.stringify(response.data, null, 2))
                    i++
                    setOpFeedback("Tracing back at START - " + i);
                    //address jwt of prev with uuid of prev as key
                    jwt_of_prev = JSON.parse(response.data.result)[current.attributes.prev_vp_uuid]

                    setOpFeedback("Decoding jwt of START - " + i);


                    response = await axios.get(`${addressVeramoAgent}/decode_jwt`, {
                        timeout: 65000,
                        params: {
                            jwt: jwt_of_prev
                        }
                    });
                    prev = response.data

                    history.push(prev)
                    setOpFeedback("Decoded jwt up to (START - " + i + " ) proceed");

                    if (prev.attributes.type === 'origin') {
                        current = null
                    } else {
                        current = prev
                    }
                }
                setOpFeedback("Traced back " + i + " Verifiable Presentation Diffusion");
                setTraceLen(i)
                setChainOfVP(history)
            } catch (error) {
                console.error('Error tracing back:', error);
                setOpFeedback("Error in VP traceback")
            }
            try {
                // Fetch and decode a list of Statement VCs
                const statementCIDs = decodedJWT.attributes.statement_vc_cid_list;
                console.log("Trying to get Statement VCs: " + statementCIDs);

                const decodedVCs = [];
                for (let i = 0; i < statementCIDs.length; i++) {
                    const cid = statementCIDs[i];
                    console.log(`Fetching CID ${i + 1}: ${cid}`);

                    // Fetch Statement VC from IPFS Agent
                    const responseFetch = await axios.get(`${addressIPFSAgent}/retrieve`, {
                        timeout: 120000, // 2 min wait max
                        params: {cid}
                    });
                    console.log("Response received for CID " + (i + 1) + ": " + responseFetch.data.result);
                    const jwtOfPrev = responseFetch.data.result;

                    // Decode the JWT using Veramo Agent
                    setOpFeedback(`Decoding Statement VC ${i + 1}`);
                    const responseDecode = await axios.get(`${addressVeramoAgent}/decode_jwt`, {
                        timeout: 65000,
                        params: {jwt: jwtOfPrev}
                    });

                    const VC = responseDecode.data;
                    console.log("Decoded VC " + (i + 1) + ": " + JSON.stringify(VC));

                    // Add the decoded VC to the list
                    decodedVCs.push(VC);
                }

                // Update the state with the list of decoded VCs
                setVerifiableCredentialStatement(decodedVCs);
                setOpFeedback("All Statement VCs decoded and traced successfully");

            } catch (error) {
                console.error("Error during VC statement trace back: " + error);
                setOpFeedback("Error in VC statement trace back, maybe missing");
            }
        }


        <textarea
            className="jwt-textarea"
            style={{overflowX: 'auto', width: '100%', minHeight: '100px'}}
            value={JSON.stringify(jsonVPsSharing, null, 2)}
        />

        return (
            <div className="dids-data" style={{align: 'center', textAlign: 'center', width: '70vw'}}>
                <p className="title-dids-data">Provide JWT of Diffusion Verifiable Presentation:</p>
                <p>Text JWT or QRCODE of JWT:</p>

                <p className="feedback-text">{opFeedback}</p>
                <textarea
                    className="form-input-area"
                    placeholder="Enter JWT"
                    value={inputJWT}
                    onChange={(e) => setInputJWT(e.target.value)}
                />
                <div style={{display: 'flex', justifyContent: 'center', alignItems: 'center', height: '8vw'}}>
                    <FileUploader
                        handleChange={handleChange}
                        name="file"
                        types={fileTypes}
                        style={{
                            width: '100%', // Adjust the width as per your requirement
                            height: '100%', // Adjust the height as per your requirement
                            objectFit: 'cover', // Ensure the image fills the container
                            overflow: 'hidden', // Hide any overflow to prevent cropping
                            maxWidth: '100%', // Allow the image to grow larger than its original size
                            maxHeight: '100%', // Allow the image to grow larger than its original size
                        }}
                    />
                </div>

                <button className="process-button" onClick={decodeJWTVerifiablePresentationsText}
                >
                    Decode Diffusion VP Text
                </button>
                <div>
                </div>

                <button className="process-button" onClick={decodeJWTVerifiablePresentationsImg}
                >
                    Decode Diffusion VP Image
                </button>
                <h3>Trace Back after decoding</h3>


                {decodedJWT && (
                    <div key='decodedJWT1' className="credential">
                        {decodedJWT.attributes.type && (
                            <div key='decodedJWT2' className="credential">

                                <button className="process-button" onClick={traceBack}
                                >
                                    Trace Back to Statement Verifiable Credential
                                </button>


                                <p className="feedback-text">{opFeedback}</p>
                                <p className="feedback-text">{opFeedback}</p>
                                {verifiableCredentialStatement && Array.isArray(verifiableCredentialStatement) ? (
                                    verifiableCredentialStatement.map((vc, index) => (
                                        <div key={`cred-${index}`} className="credential">
                                            <h3>Statement Verifiable Credential #{index + 1}</h3>

                                            {<button className="action-button"
                                                     onClick={() => fetchSkillsFromVC(vc)}>Fetch Skills VC</button>}
                                            <div><p></p></div>
                                            <button className="action-button" onClick={() => verifyStatementVC(vc)}>
                                                Verify Statement Verifiable Credential
                                            </button>
                                            <p>Result verification: <b>{risVC}</b></p>

                                            <p>Issuance Date: {vc.issuanceDate}</p>
                                            <p>Credential Type: {vc.type.join(', ')}</p>
                                            <p>Holder DID: {vc.credentialSubject.id}</p>
                                            <h3>Issuer CAVS DID: {vc.issuer.id}</h3>
                                            <textarea
                                                readOnly={true}
                                                className="input"
                                                value={JSON.stringify(vc.credentialSubject, null, 2)}
                                            />
                                            <button className="action-button" onClick={closeSkill}>Close Skills VC
                                            </button>

                                            {jsonDataVCSkills.length > 0 && (
                                                <div key='skills' className="credential">
                                                    <p>Skill Credential from keywords</p>

                                                    {jsonDataVCSkills.map((credential, i) => (
                                                        <div key={`skill-${i}`} className="credential">
                                                            <h3>Skill Credential #{i + 1}</h3>
                                                            <button className="process-button"
                                                                    onClick={() => verifySkill(credential, i)}>Verify
                                                            </button>
                                                            <p>Verification Result: <b>{verificationResSkill.at(i)}</b>
                                                            </p>
                                                            <p>Issuance Date: {credential.issuanceDate}</p>
                                                            <p>Credential Type: {credential.type.join(', ')}</p>
                                                            <p>Issuer DID: {credential.issuer.id}</p>
                                                            <p>Holder DID: {credential.credentialSubject.id}</p>
                                                            <textarea
                                                                readOnly={true}
                                                                className="input"
                                                                value={JSON.stringify(credential.credentialSubject, null, 2)}
                                                            />

                                                        </div>
                                                    ))}
                                                </div>
                                            )}


                                            {jsonDataVCSkills2.length > 0 && (
                                                <div key='skills2' className="credential">
                                                    <p>Skill Credential similar keyword</p>

                                                    {jsonDataVCSkills2.map((credential, i) => (
                                                        <div key={`skill2-${i}`} className="credential">
                                                            <h3>Skill Credential #{i + 1}</h3>
                                                            <button className="process-button"
                                                                    onClick={() => verifySkill(credential, i)}>Verify
                                                            </button>
                                                            <p>Verification Result: <b>{verificationResSkill.at(i)}</b>
                                                            </p>
                                                            <p>Issuance Date: {credential.issuanceDate}</p>
                                                            <p>Credential Type: {credential.type.join(', ')}</p>
                                                            <p>Issuer DID: {credential.issuer.id}</p>
                                                            <p>Holder DID: {credential.credentialSubject.id}</p>
                                                            <textarea
                                                                readOnly={true}
                                                                className="input"
                                                                value={JSON.stringify(credential.credentialSubject, null, 2)}
                                                            />
                                                        </div>
                                                    ))}
                                                </div>
                                            )}

                                            {jsonDataVCSkills3.length > 0 && (
                                                <div key='skills3' className="credential">
                                                    <p>Skill Credential higher concept keyword</p>

                                                    {jsonDataVCSkills3.map((credential, i) => (
                                                        <div key={`skill3-${i}`} className="credential">
                                                            <h3>Skill Credential #{i + 1}</h3>
                                                            <button className="process-button"
                                                                    onClick={() => verifySkill(credential, i)}>Verify
                                                            </button>
                                                            <p>Verification Result: <b>{verificationResSkill.at(i)}</b>
                                                            </p>
                                                            <p>Issuance Date: {credential.issuanceDate}</p>
                                                            <p>Credential Type: {credential.type.join(', ')}</p>
                                                            <p>Issuer DID: {credential.issuer.id}</p>
                                                            <p>Holder DID: {credential.credentialSubject.id}</p>
                                                            <textarea
                                                                readOnly={true}
                                                                className="input"
                                                                value={JSON.stringify(credential.credentialSubject, null, 2)}
                                                            />
                                                        </div>
                                                    ))}
                                                </div>
                                            )}
                                        </div>
                                    ))
                                ) : (
                                    <p>No Verifiable Credentials available</p>
                                )}


                            </div>)}
                        <h3>Decoded Diffusion VP</h3>
                        <h3>Discovered distance from origin: {traceLen}</h3>
                        <button className="process-button"
                                onClick={() => verifyVPDecoded(decodedJWT)}> Verify
                        </button>
                        <p>Result verification: <b>{risVerDecoded}</b></p> {/* Type from Credential Subject */}

                        <p>Type: {decodedJWT.attributes.type}</p> {/* Type from Credential Subject */}
                        <p>Issuance Date: {decodedJWT.issuanceDate}</p> {/* Issuance Date from VP */}
                        <h3 style={{overflowX: 'auto', width: '100%', minHeight: 'auto'}}>UUID of
                            VP: {decodedJWT.id}</h3> {/* UUID from Issuer DID */}
                        <h3 style={{overflowX: 'auto', width: '100%', minHeight: 'auto'}}>URL or CID on IPFS of
                            prev JWT
                            URL: {decodedJWT.attributes.url_or_cid_jwt_prev}</h3> {/* vc_statement_cid_or_url */}
                        <h3 style={{overflowX: 'auto', width: '100%', minHeight: 'auto'}}>VC statement CID or
                            URL: {decodedJWT.attributes.statement_vc_cid_list}</h3> {/* vc_statement_cid_or_url */}
                        <h3 style={{overflowX: 'auto', width: '100%', minHeight: 'auto'}}>Hash of statement
                            Hash: {decodedJWT.attributes.hash_of_statement}</h3> {/* hash_of_statement */}
                        <h3 style={{overflowX: 'auto', width: '100%', minHeight: 'auto'}}>Hashing algorithm for
                            reproducibility
                            Hashing Algorithm: {decodedJWT.attributes.hashing_algo}</h3> {/* hashing_algo */}
                        <p style={{overflowX: 'auto', width: '100%', minHeight: 'auto'}}>Holder
                            DID: {decodedJWT.holder}</p> {/* Holder DID */}
                        <p style={{overflowX: 'auto', width: '100%', minHeight: 'auto'}}>Host
                            URL: {decodedJWT.attributes.host_URL}</p> {/* HostURL */}
                        <p style={{overflowX: 'auto', width: '100%', minHeight: 'auto'}}>Prev
                            UUID: {decodedJWT.attributes.prev_vp_uuid}</p>
                        <h3>JWT of Diffusion VP for next Diffusion VP</h3>
                        <textarea
                            className="jwt-textarea"
                            style={{overflowX: 'auto', width: '90%', minHeight: '100px'}}
                            value={decodedJWT.proof.jwt}
                            readOnly/>
                        {chainOfVP && (
                            <div key='decodedJWT' className="credential">

                                {chainOfVP.map((presentation, index) => (
                                        <div key={index} className="credential">
                                            <h3>Diffusion VP with distance from
                                                origin: {traceLen - (index + 1)}</h3>
                                            <button className="process-button"
                                                    onClick={() => verifyVPSharing(presentation, index)}> Verify
                                            </button>
                                            <p>Verification Result: <b>{verificationResSharingVP.at(index)}</b></p>

                                            <p>Type: {presentation.attributes.type}</p> {/* Type from Credential Subject */}
                                            <p>Issuance
                                                Date: {presentation.issuanceDate}</p> {/* Issuance Date from VP */}
                                            <h3 style={{overflowX: 'auto', width: '100%', minHeight: 'auto'}}>UUID
                                                of
                                                VP: {presentation.id}</h3> {/* UUID from Issuer DID */}
                                            <h3 style={{overflowX: 'auto', width: '100%', minHeight: 'auto'}}>URL or
                                                CID on
                                                IPFS
                                                of prev JWT
                                                URL: {presentation.attributes.url_or_cid_jwt_prev}</h3> {/* vc_statement_cid_or_url */}
                                            <h3 style={{overflowX: 'auto', width: '100%', minHeight: 'auto'}}>VC
                                                statement
                                                CID
                                                or
                                                URL: {presentation.attributes.statement_vc_cid_list}</h3> {/* vc_statement_cid_or_url */}
                                            <p style={{overflowX: 'auto', width: '100%', minHeight: 'auto'}}>Holder
                                                DID: {presentation.holder}</p> {/* Holder DID */}
                                            <p style={{overflowX: 'auto', width: '100%', minHeight: 'auto'}}>Host
                                                URL: {presentation.attributes.host_URL}</p> {/* HostURL */}
                                            <p style={{overflowX: 'auto', width: '100%', minHeight: 'auto'}}>Prev
                                                UUID: {presentation.attributes.prev_vp_uuid}</p>

                                            <h3>JWT of Diffusion VP #{index + 1} for next Diffusion VP</h3>

                                            <textarea
                                                className="jwt-textarea"
                                                style={{overflowX: 'auto', width: '90%', minHeight: '100px'}}
                                                value={presentation.proof.jwt}
                                                readOnly/>


                                        </div>
                                    )
                                )}
                            </div>
                        )}

                    </div>
                )}
                <div>
                    <p>--</p>
                </div>
                <button className="process-button" onClick={fetchVerifiablePresentations}>Fetch Diffusion VP
                </button>
                {jsonVPsSharing.map((presentation, index) => (
                        <div key={index} className="credential">
                            <h3>Sharing VP #{index + 1}</h3>
                            <p>Type: {presentation.verifiablePresentation.attributes.type}</p> {/* Type from Credential Subject */}
                            <p>Issuance
                                Date: {presentation.verifiablePresentation.issuanceDate}</p> {/* Issuance Date from VP */}
                            <h3 style={{overflowX: 'auto', width: '100%', minHeight: 'auto'}}>UUID of
                                VP: {presentation.verifiablePresentation.id}</h3> {/* UUID from Issuer DID */}
                            <h3 style={{overflowX: 'auto', width: '100%', minHeight: 'auto'}}>URL or CID on IPFS of
                                prev JWT
                                URL: {presentation.verifiablePresentation.attributes.url_or_cid_jwt_prev}</h3> {/* vc_statement_cid_or_url */}
                            <h3 style={{overflowX: 'auto', width: '100%', minHeight: 'auto'}}>VC statement CID or
                                URL: {presentation.verifiablePresentation.attributes.statement_vc_cid_list}</h3> {/* vc_statement_cid_or_url */}
                            <h3 style={{overflowX: 'auto', width: '100%', minHeight: 'auto'}}>Hash of statement
                                URL: {presentation.verifiablePresentation.attributes.hash_of_statement}</h3> {/* vc_statement_cid_or_url */}
                            <h3 style={{overflowX: 'auto', width: '100%', minHeight: 'auto'}}>Hashing algorithm for
                                reproducibility
                                URL: {presentation.verifiablePresentation.attributes.hashing_algo}</h3> {/* vc_statement_cid_or_url */}
                            <p style={{overflowX: 'auto', width: '100%', minHeight: 'auto'}}>Holder
                                DID: {presentation.verifiablePresentation.holder}</p> {/* Holder DID */}
                            <p style={{overflowX: 'auto', width: '100%', minHeight: 'auto'}}>Host
                                URL: {presentation.verifiablePresentation.attributes.host_URL}</p> {/* HostURL */}
                            <p style={{overflowX: 'auto', width: '100%', minHeight: 'auto'}}>Prev
                                UUID: {presentation.verifiablePresentation.attributes.prev_vp_uuid}</p>

                            <h3>JWT of Sharing VP #{index + 1} for next Sharing VP</h3>

                            <textarea
                                className="jwt-textarea"
                                style={{overflowX: 'auto', width: '90%', minHeight: '100px'}}
                                value={presentation.verifiablePresentation.proof.jwt}
                                readOnly/>


                        </div>
                    )
                )}
                {jsonVPsSharing.length > 0 && (
                    <textarea
                        className="jwt-textarea"
                        style={{overflowX: 'auto', width: '100%', minHeight: '100px'}}
                        value={JSON.stringify(jsonVPsSharing, null, 2)}
                        readOnly
                    />
                )}


            </div>
        );
    };


    return (
        <div className="container">
            <div className="credential-form">
                <div className="form-group">
                    <label className="form-label" htmlFor="ethereumAddress">Ethereum Wallet Address DID:</label>
                    <input
                        type="text"
                        className="form-input"
                        id="ethereumAddress"
                        value={ethrAddr}
                        onChange={(e) => setEthrAddr(e.target.value)}
                    />
                    <label className="form-label" htmlFor="ethPrivKey">Ethereum account private key:</label>
                    <input
                        type="text"
                        className="form-input"
                        id="ethereumPrivateKey"
                        value={ethrPrivKey}
                        onChange={(e) => setEthrPrivKey(e.target.value)}
                    />
                    <button className="action-button" onClick={newDIDEHTR}>Import ETHR DID</button>
                </div>

                {dids.length === 0 ? (
                    <div>
                        <p>Loading Dids of Agent</p>
                        <button className="action-button" onClick={newDID}>Generate new DID</button>
                    </div>
                ) : (
                    <div className="dids-data">
                        <p className="title-dids-data">Veramo Agent endpoint: {addressVeramoAgent}</p>
                        <p className="title-dids-data">Select DID from wallet:</p>
                        <select
                            className="dids-select"
                            value={selectedDid}
                            onChange={(e) => setSelectedDid(e.target.value)}
                        >
                            {dids.map((did, i) => (
                                <option key={i} value={did}>
                                    {did}
                                </option>
                            ))}
                        </select>
                        <p className="form-label">{selectedDid}</p>

                        <button className="action-button" onClick={newDID}>Generate new DID</button>
                    </div>
                )}

                <div className="dids-data">
                    <p className="title-dids-data">Choose role:</p>
                    <select
                        className="dids-select"
                        value={selectedRole}
                        onChange={(e) => setSelectedRole(e.target.value)}
                    >
                        {roles.map((r, i) => (
                            <option key={i} value={r}>
                                {r}
                            </option>
                        ))}
                    </select>
                </div>

                {selectedDid && selectedRole === "CertificateIssuer" ? (
                    <CertificateIssuerForm/>
                ) : (
                    <div/>
                )}
                {selectedDid && selectedRole === "CAVS" ? (
                    <CavsComponentPanel/>
                ) : (
                    <div/>
                )}
                {selectedDid && selectedRole === "AuthorHolder" ? (
                    <AuthorHolder/>
                ) : (
                    <div/>
                )}
                {selectedDid && selectedRole === "Spreader" ? (
                    <Spreader/>
                ) : (
                    <div/>
                )}
                {selectedDid && selectedRole === "ReaderVerifier" ? (
                    <ReaderVerifier/>
                ) : (
                    <div/>
                )}

                <div className="dids-data" align="center">
                    <div className="form-group">
                        <label className="form-label" htmlFor="skillUri">QRCODE from JWT:</label>
                        <input
                            type="text"
                            className="form-input"
                            id="verifiableCredentialHash1"
                            value={verifiableCredentialHash1}
                            onChange={(e) => setVerifiableCredentialHash1(e.target.value)}
                        />
                    </div>
                    <button className="process-button" onClick={getQR}>Get QRCODE</button>
                    <div>
                        {image ? (
                            <img src={`data:image/png;base64,${image}`} alt="QR Code"/>
                        ) : (
                            <p>No image.</p>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
};
export default App;
