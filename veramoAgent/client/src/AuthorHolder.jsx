import React, {useState} from "react";
import axios from "axios";

const AuthorHolder = ({
                          jsonDataVCSkills,
                          setJsonDataVCSkills,
                          jsonDataVCStatement,
                          setjsonDataVCStatement,
                          selectedCredentials,
                          setSelectedCredentials,
                          statementText,
                          setStatementText,
                          opFeedback,
                          setOpFeedback,
                          hostURLStatement,
                          setHostURLStatement,
                          categoryStatement,
                          setCategoryStatement,
                          typeStatement,
                          setTypeStatement,
                          selectedTypeStatement,
                          setSelectedTypeStatement,
                          listCIDs,
                          setListCIDs,
                          addressCAVS,
                          selectedDid
                      }) => {
    const [jsonDataVCSkills, setJsonDataVCSkills] = useState('');
    const [jsonDataVCStatement, setjsonDataVCStatement] = useState('');

    const [selectedCredentials, setSelectedCredentials] = useState([]);
    const [statementText, setStatementText] = useState("")
    const [opFeedback,setOpFeedback] = useState("Ready to Request")
    const [hostURLStatement,setHostURLStatement] = useState("")
    const [categoryStatement,setCategoryStatement] = useState("")
    const [typeStatement,setTypeStatement] = useState(["News","Article","Rumor","Comment","Opinion","Leak","Blog","Post"])
    const [selectedTypeStatement,setSelectedTypeStatement] = useState(typeStatement[0])

    const [listCIDs,setListCIDs] = useState([])


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

    // Function to fetch credentials
    const sendToCavs = async () => {
        let credentials = []
        console.log(jsonDataVCSkills.at(0))
        if (selectedCredentials.length === 0){
            setOpFeedback("Please select VCs")
            return;
        }
        for (let i = 0; i < selectedCredentials.length; i++) {
            credentials.push(jsonDataVCSkills.at(selectedCredentials.at(i)).verifiableCredential)
        }
        console.log(credentials)

        try {

            let response = await axios.post(
                `${addressCAVS}/api/vc`,
                {
                    document:statementText,
                    credentials:credentials,
                    typeStatement:selectedTypeStatement,
                    category:categoryStatement,
                    hostURL:hostURLStatement,
                    holderDID:selectedDid
                },
                {
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    timeout: 65000
                }
            );
            console.log(response)


            setOpFeedback("Got VC Statement, storing in wallet");

            response = await axios.post(`${addressVeramoAgent}/store_vc`, {
                verifiableCredential: response.data.jwt
            }, {
                headers: {
                    'Content-Type': 'application/json'
                },
                timeout: 650000
            });
            console.log(response)
            setStatementText("")
            setCategoryStatement("")
            setHostURLStatement("")



            setOpFeedback("Done")

        } catch (error) {
            console.error('Error obtain credentials:', error);
        }
    };
    const fetchCredentials = async() => {
        try {
            const response = await axios.get(`${addressVeramoAgent}/list_verifiable_credentials_with_type`, {
                timeout: 65000,
                params: {
                    type: "ESCO_type_VerifiableCredential"
                }
            });
            setJsonDataVCSkills(response.data);
        } catch (error) {
            console.error('Error fetching credentials:', error);
        }

    };

    const fetchStatementCredentials= async() => {
        try {
            const response = await axios.get(`${addressVeramoAgent}/list_verifiable_credentials_with_type`, {
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

    const ipfsPublish= async(id) => {
        try {
            let response = await axios.post(
                `${addressIPFSAgent}/upload`,
                {
                    //sending jwt
                    text:jsonDataVCStatement[id].verifiableCredential.proof.jwt
                },
                {
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    timeout: 65000
                }
            );

            console.log("received response"+ response.data.CID)
            const updatedListCIDs = [...listCIDs]; // Create a copy of the array
            updatedListCIDs[id] = response.data.CID; // Update the value at the specified index
            console.log("id:" + id);
            console.log("updated CID at index " + id + ": " + updatedListCIDs[id]);
            setListCIDs(updatedListCIDs); // Update the state with the new array
        } catch (error) {
            console.error('Error fetching credentials:', error);
        }

    };

    return (
        <div className="dids-data" style={{textAlign:'center'}}>
            <button className="process-button" onClick={fetchCredentials}>Fetch ESCO Skills Verifiable Credential
            </button>
            {jsonDataVCSkills && (
                <div className="credentials-list-container">
                    <p>Select Credentials for VC</p>

                    {jsonDataVCSkills.map((credential, index) => (
                        <div key={index} className="credential">
                            <input
                                style={{width:'2vw', height:'2vw'}} // Set the width and height
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
            <label className="form-label" htmlFor="holderURL">Statement Host URL</label>
            <input
                type="text"
                className="form-input"
                id="holderURL"
                value={hostURLStatement}
                onChange={(e) => setHostURLStatement(e.target.value)}
            />
            <label className="form-label" htmlFor="holderURL">Statement Type:</label>
            <select
                className="select-box"
                value={selectedTypeStatement}
                onChange={(e) => {setSelectedTypeStatement(e.target.value); }  }
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
            <button className="process-button" onClick={sendToCavs}>Send to CAVS
            </button>
            <p className="feedback-text">{opFeedback}</p>
            <div></div>
            <button className="process-button" onClick={fetchStatementCredentials}> Fetch StatementVerifiableCredentials
            </button>

            {jsonDataVCStatement && (
                <div className="credentials-list-container">
                    {jsonDataVCStatement.map((credential, index) => (
                        <div key={index} className="credential">


                            <button className="process-button" onClick={() => ipfsPublish(index)}> Publish/Get on
                                IPFS
                            </button>

                            <h3>Credential #{index + 1}</h3>
                            {listCIDs[index]? (
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
