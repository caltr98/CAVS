import React, { useEffect, useState } from "react";
import {
    CodeView,
    DetailPanel,
    EmptyState,
    PageHero,
    StatusCard,
    StickyActions,
    SurfaceCard,
} from "../components/Shell";
import { statementTypes, useAuthorFlow } from "../context/AuthorFlowContext";
import { useSession } from "../context/SessionContext";
import { api } from "../services/api";
import {
    createArtifactFilename,
    downloadJsonFile,
    isJwtLike,
    normalizeStoredArtifact,
    safeJsonParse,
    startJsonDrag,
} from "../utils/artifacts";

function CredentialSelectionCard({
    credentials,
    selectedIndexes,
    toggleSelection,
    title,
    subtitle,
}) {
    return (
        <SurfaceCard title={title} subtitle={subtitle}>
            <div className="record-stack">
                {credentials.length ? (
                    credentials.map((credential, index) => (
                        <article key={`${credential.hash}-${index}`} className="record-item">
                            <label className="checkbox-row">
                                <input
                                    checked={selectedIndexes.includes(index)}
                                    onChange={() => toggleSelection(index)}
                                    type="checkbox"
                                />
                                <span>
                                    Credential #{index + 1} / {credential.hash}
                                </span>
                            </label>
                            <p className="record-item__meta">
                                Issuer: {credential?.verifiableCredential?.issuer?.id || "Unknown"}
                            </p>
                            <p className="record-item__meta">
                                Holder:{" "}
                                {credential?.verifiableCredential?.credentialSubject?.id || "Unknown"}
                            </p>
                            <DetailPanel label="Technical Details">
                                <CodeView data={credential} />
                            </DetailPanel>
                        </article>
                    ))
                ) : (
                    <p className="muted-copy">No credentials loaded yet.</p>
                )}
            </div>
        </SurfaceCard>
    );
}

function readFileAsText(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = reject;
        reader.readAsText(file);
    });
}

function formatOracleRequestLogs(session) {
    if (!session?.logs?.length) {
        return "";
    }
    return session.logs.join("\n");
}

export function AuthorRequestPage() {
    const {
        authorMessage,
        clearSelections,
        selectedCredentialIndexes,
        setAuthorMessage,
        setSkillsCredentials,
        skillsCredentials,
        toggleCredentialIndex,
    } = useAuthorFlow();
    const { selectedCavsEndpoint, selectedDid, setSessionMessage, veramoEndpoint } = useSession();

    const [statementText, setStatementText] = useState("");
    const [categoryStatement, setCategoryStatement] = useState("");
    const [selectedTypeStatement, setSelectedTypeStatement] = useState(statementTypes[0]);
    const [lastResponse, setLastResponse] = useState(null);

    async function fetchCredentials() {
        try {
            const standardCredentials = await api.listCredentialsByType(
                veramoEndpoint,
                "ESCO_type_VerifiableCredential",
            );
            setSkillsCredentials(standardCredentials || []);
            setAuthorMessage("Author credentials loaded from the wallet.");
        } catch (error) {
            setAuthorMessage("Unable to fetch author credentials.");
        }
    }

    async function sendToCavs() {
        if (!selectedCavsEndpoint) {
            setAuthorMessage("Choose a CAVS endpoint in the session header.");
            return;
        }
        if (!selectedDid) {
            setAuthorMessage("Choose a DID in the session header.");
            return;
        }

        const credentials = selectedCredentialIndexes.map(
            (index) => skillsCredentials[index]?.verifiableCredential,
        );

        try {
            const response = await api.createStatementVc(selectedCavsEndpoint, {
                category: categoryStatement,
                credentials,
                document: statementText,
                holderDID: selectedDid,
                statementTitle: statementText.substring(0, 30),
                typeStatement: selectedTypeStatement,
            });

            await api.storeVc(veramoEndpoint, {
                did: selectedDid,
                verifiableCredential: response.jwt,
            });

            setLastResponse(response);
            setSessionMessage("Statement VC stored in the wallet.");
            clearSelections();
            setStatementText("");
            setCategoryStatement("");
            setAuthorMessage("Statement VC created and stored.");
        } catch (error) {
            setAuthorMessage("Unable to create the statement VC.");
        }
    }

    if (!selectedDid) {
        return (
            <EmptyState
                title="No active DID"
                description="Create or import a DID first."
            />
        );
    }

    return (
        <>
            <PageHero
                eyebrow="Author"
                title="Request statement"
            />

            <div className="page-grid">
                <SurfaceCard title="Statement">
                    <label className="field field--wide">
                        <span className="field__label">Active CAVS Endpoint</span>
                        <input className="input-control" readOnly value={selectedCavsEndpoint} />
                    </label>
                    <div className="field-grid">
                        <label className="field">
                            <span className="field__label">Category</span>
                            <input
                                className="input-control"
                                onChange={(event) => setCategoryStatement(event.target.value)}
                                value={categoryStatement}
                            />
                        </label>
                        <label className="field">
                            <span className="field__label">Statement Type</span>
                            <select
                                className="select-control"
                                onChange={(event) => setSelectedTypeStatement(event.target.value)}
                                value={selectedTypeStatement}
                            >
                                {statementTypes.map((typeStatement) => (
                                    <option key={typeStatement} value={typeStatement}>
                                        {typeStatement}
                                    </option>
                                ))}
                            </select>
                        </label>
                    </div>
                    <label className="field field--wide">
                        <span className="field__label">Statement</span>
                        <textarea
                            className="text-area"
                            onChange={(event) => setStatementText(event.target.value)}
                            placeholder="Statement text"
                            value={statementText}
                        />
                    </label>
                    <div className="button-row">
                        <button className="secondary-button" type="button" onClick={fetchCredentials}>
                            Load credentials
                        </button>
                    </div>
                </SurfaceCard>

                <StatusCard message={authorMessage} />

                <CredentialSelectionCard
                    credentials={skillsCredentials}
                    selectedIndexes={selectedCredentialIndexes}
                    title="Credential library"
                    toggleSelection={toggleCredentialIndex}
                />
            </div>

            <StickyActions>
                <button className="primary-button" type="button" onClick={sendToCavs}>
                    Send
                </button>
            </StickyActions>

            {lastResponse ? (
                <SurfaceCard title="Last response">
                    <DetailPanel label="Technical Details">
                        <CodeView data={lastResponse} />
                    </DetailPanel>
                </SurfaceCard>
            ) : null}
        </>
    );
}

export function AuthorOracleRequestPage() {
    const {
        authorMessage,
        selectedCredentialIndexes,
        setAuthorMessage,
        setSkillsCredentials,
        skillsCredentials,
        toggleCredentialIndex,
    } = useAuthorFlow();
    const { selectedCavsEndpoint, selectedDid, setSessionMessage, veramoEndpoint } = useSession();

    const [statementText, setStatementText] = useState("");
    const [oracleContractRpcUrl, setOracleContractRpcUrl] = useState("");
    const [oracleContractAddress, setOracleContractAddress] = useState("");
    const [oracleContractDefaults, setOracleContractDefaults] = useState(null);
    const [oracleRequestSession, setOracleRequestSession] = useState(null);
    const [oracleRequestBusy, setOracleRequestBusy] = useState(false);
    const [storedOracleSessionId, setStoredOracleSessionId] = useState("");
    const [lastResponse, setLastResponse] = useState(null);

    useEffect(() => {
        let ignore = false;

        async function loadOracleDefaults() {
            if (!selectedCavsEndpoint) {
                return;
            }

            try {
                const data = await api.getOcrOracleRegistryDefaults(selectedCavsEndpoint);
                if (ignore) {
                    return;
                }
                setOracleContractDefaults(data);
                if (data.rpcUrl) {
                    setOracleContractRpcUrl(data.rpcUrl);
                }
                if (data.contractAddress) {
                    setOracleContractAddress(data.contractAddress);
                }
            } catch (_error) {
                if (!ignore) {
                    setOracleContractDefaults(null);
                }
            }
        }

        loadOracleDefaults();

        return () => {
            ignore = true;
        };
    }, [selectedCavsEndpoint]);

    useEffect(() => {
        if (!selectedCavsEndpoint || !oracleRequestSession?.sessionId) {
            return undefined;
        }
        if (["done", "partial", "timeout", "error"].includes(oracleRequestSession.status)) {
            return undefined;
        }

        let ignore = false;

        async function pollOracleRequest() {
            try {
                const data = await api.getAuthorOracleRequestStatus(
                    selectedCavsEndpoint,
                    oracleRequestSession.sessionId,
                );
                if (!ignore) {
                    setOracleRequestSession(data);
                    setLastResponse(data);
                }
            } catch (_error) {
                if (!ignore) {
                    setAuthorMessage("Unable to refresh the oracle request status.");
                }
            }
        }

        void pollOracleRequest();
        const timer = window.setInterval(pollOracleRequest, 2500);

        return () => {
            ignore = true;
            window.clearInterval(timer);
        };
    }, [oracleRequestSession?.sessionId, oracleRequestSession?.status, selectedCavsEndpoint, setAuthorMessage]);

    useEffect(() => {
        if (!oracleRequestSession?.finalVc || !oracleRequestSession?.sessionId) {
            return;
        }
        if (storedOracleSessionId === oracleRequestSession.sessionId) {
            return;
        }

        let ignore = false;

        async function storeOracleVc() {
            try {
                await api.storeStructuredVc(veramoEndpoint, {
                    vc: oracleRequestSession.finalVc,
                });
                if (ignore) {
                    return;
                }
                setStoredOracleSessionId(oracleRequestSession.sessionId);
                setSessionMessage("Oracle network VC stored in the wallet.");
                setAuthorMessage("Oracle network VC created and stored.");
            } catch (_error) {
                if (!ignore) {
                    setAuthorMessage("Oracle network VC is ready, but storing it failed.");
                }
            }
        }

        void storeOracleVc();

        return () => {
            ignore = true;
        };
    }, [oracleRequestSession, storedOracleSessionId, setAuthorMessage, setSessionMessage, veramoEndpoint]);

    async function fetchCredentials() {
        try {
            const standardCredentials = await api.listCredentialsByType(
                veramoEndpoint,
                "ESCO_type_VerifiableCredential",
            );
            setSkillsCredentials(standardCredentials || []);
            setAuthorMessage("Author credentials loaded from the wallet.");
        } catch (error) {
            setAuthorMessage("Unable to fetch author credentials.");
        }
    }

    async function requestOracles() {
        if (!selectedCavsEndpoint) {
            setAuthorMessage("Choose a CAVS endpoint in the session header.");
            return;
        }
        if (!selectedDid) {
            setAuthorMessage("Choose a DID in the session header.");
            return;
        }
        if (!statementText.trim()) {
            setAuthorMessage("Statement text is required.");
            return;
        }
        if (!oracleContractRpcUrl.trim() || !oracleContractAddress.trim()) {
            setAuthorMessage("Oracle Coordinator Smart Contract RPC URL and address are required.");
            return;
        }

        const credentials = selectedCredentialIndexes
            .map((index) => skillsCredentials[index]?.verifiableCredential)
            .filter(Boolean);
        if (!credentials.length) {
            setAuthorMessage("Select at least one credential before requesting the oracle network.");
            return;
        }

        setOracleRequestBusy(true);
        try {
            const response = await api.startAuthorOracleRequest(selectedCavsEndpoint, {
                statement: statementText,
                holderDid: selectedDid,
                credentials,
                contractRpcUrl: oracleContractRpcUrl.trim(),
                contractAddress: oracleContractAddress.trim(),
            });
            setOracleRequestSession(response);
            setStoredOracleSessionId("");
            setLastResponse(response);
            setAuthorMessage(
                `Oracle request submitted to ${response.oracles?.length || 0} registered endpoints.`,
            );
        } catch (error) {
            setAuthorMessage("Unable to submit the oracle network request.");
        } finally {
            setOracleRequestBusy(false);
        }
    }

    const rpcUrlLooksPrefilled =
        Boolean(oracleContractDefaults?.rpcUrl) &&
        oracleContractRpcUrl.trim() === String(oracleContractDefaults.rpcUrl).trim();
    const contractAddressLooksPrefilled =
        Boolean(oracleContractDefaults?.contractAddress) &&
        oracleContractAddress.trim().toLowerCase() ===
            String(oracleContractDefaults.contractAddress).trim().toLowerCase();

    if (!selectedDid) {
        return (
            <EmptyState
                title="No active DID"
                description="Create or import a DID first."
            />
        );
    }

    return (
        <>
            <PageHero
                eyebrow="Author"
                title="Request Oracles"
            />

            <div className="page-grid">
                <SurfaceCard title="Statement">
                    <label className="field field--wide">
                        <span className="field__label">Active CAVS Endpoint</span>
                        <input className="input-control" readOnly value={selectedCavsEndpoint} />
                    </label>
                    <label className="field field--wide">
                        <span className="field__label">Statement</span>
                        <textarea
                            className="text-area"
                            onChange={(event) => setStatementText(event.target.value)}
                            placeholder="Statement text"
                            value={statementText}
                        />
                    </label>
                    <div className="button-row">
                        <button className="secondary-button" type="button" onClick={fetchCredentials}>
                            Load credentials
                        </button>
                    </div>
                </SurfaceCard>

                <StatusCard message={authorMessage} />

                <SurfaceCard title="Oracle Coordinator">
                    <div className="field-grid">
                        <label className="field">
                            <span className="field__label">Contract RPC URL</span>
                            <input
                                className={
                                    rpcUrlLooksPrefilled
                                        ? "input-control input-control--prefilled"
                                        : "input-control"
                                }
                                onChange={(event) => setOracleContractRpcUrl(event.target.value)}
                                placeholder="https://..."
                                value={oracleContractRpcUrl}
                            />
                        </label>
                        <label className="field">
                            <span className="field__label">Oracle Coordinator Smart Contract</span>
                            <input
                                className={
                                    contractAddressLooksPrefilled
                                        ? "input-control input-control--prefilled"
                                        : "input-control"
                                }
                                onChange={(event) => setOracleContractAddress(event.target.value)}
                                placeholder="0x..."
                                value={oracleContractAddress}
                            />
                        </label>
                    </div>
                    <p className="muted-copy">
                        Request Oracles reads the registered OCR endpoints from this coordinator, forwards the statement to each oracle queue, and waits for the returned VC.
                    </p>
                </SurfaceCard>

                <CredentialSelectionCard
                    credentials={skillsCredentials}
                    selectedIndexes={selectedCredentialIndexes}
                    title="Credential library"
                    toggleSelection={toggleCredentialIndex}
                />

                <SurfaceCard title="Oracle Replies" className="page-grid__wide">
                    <label className="field field--wide">
                        <span className="field__label">Live log</span>
                        <textarea
                            className="text-area"
                            readOnly
                            placeholder="Oracle replies will appear here."
                            value={formatOracleRequestLogs(oracleRequestSession)}
                        />
                    </label>
                    {oracleRequestSession?.finalResult ? (
                        <DetailPanel label="Final OCR Result">
                            <CodeView data={oracleRequestSession.finalResult} />
                        </DetailPanel>
                    ) : null}
                </SurfaceCard>
            </div>

            <StickyActions>
                <button
                    className="primary-button"
                    type="button"
                    onClick={requestOracles}
                    disabled={oracleRequestBusy}
                >
                    {oracleRequestBusy ? "Requesting..." : "Request Oracles"}
                </button>
            </StickyActions>

            {lastResponse ? (
                <SurfaceCard title="Last response">
                    <DetailPanel label="Technical Details">
                        <CodeView data={lastResponse} />
                    </DetailPanel>
                </SurfaceCard>
            ) : null}
        </>
    );
}

export function AuthorStatementsPage() {
    const {
        authorMessage,
        setAuthorMessage,
        setStatementCredentials,
        statementCredentials,
    } = useAuthorFlow();
    const { selectedDid, setSessionMessage, veramoEndpoint } = useSession();
    const [presentationHistory, setPresentationHistory] = useState([]);
    const [presentationJwt, setPresentationJwt] = useState("");
    const [presentationDocument, setPresentationDocument] = useState(null);
    const [presentationQrImage, setPresentationQrImage] = useState("");
    const [hostURLPresentation, setHostURLPresentation] = useState("");
    const [selectedTypePresentation, setSelectedTypePresentation] = useState("Origin");
    const [selectedStatementIndexes, setSelectedStatementIndexes] = useState([]);
    const [previousPresentationInput, setPreviousPresentationInput] = useState("");
    const [textOfStatement, setTextOfStatement] = useState("");
    const [lastPresentationResponse, setLastPresentationResponse] = useState(null);

    async function calculateHash(text) {
        const encoded = new TextEncoder().encode(text);
        const digest = await window.crypto.subtle.digest("SHA-256", encoded);
        return Array.from(new Uint8Array(digest))
            .map((byte) => byte.toString(16).padStart(2, "0"))
            .join("");
    }

    async function renderReaderQr(jwt, successMessage = "Reader QR generated.") {
        try {
            const image = await api.getQrCode(veramoEndpoint, jwt);
            setPresentationJwt(jwt);
            setPresentationQrImage(image);
            setAuthorMessage(successMessage);
        } catch (error) {
            setPresentationJwt(jwt);
            setPresentationQrImage("");
            setAuthorMessage("Presentation created, but QR rendering failed.");
        }
    }

    function toggleStatementSelection(index) {
        setSelectedStatementIndexes((previousIndexes) =>
            previousIndexes.includes(index)
                ? previousIndexes.filter((value) => value !== index)
                : [...previousIndexes, index],
        );
    }

    function downloadArtifact(prefix, artifact) {
        const document = normalizeStoredArtifact(artifact);
        downloadJsonFile(createArtifactFilename(prefix, document), document);
    }

    function loadStoredPresentationIntoBuilder(record) {
        const document = normalizeStoredArtifact(record);
        setPreviousPresentationInput(JSON.stringify(document, null, 2));
        setSelectedTypePresentation("Diffusion");
        setAuthorMessage("Previous presentation JSON loaded into the builder.");
    }

    async function loadPreviousPresentationFile(event) {
        const file = event.target.files?.[0];
        event.target.value = "";

        if (!file) {
            return;
        }

        try {
            const fileText = await readFileAsText(file);
            setPreviousPresentationInput(fileText);
            setSelectedTypePresentation("Diffusion");
            setAuthorMessage("Previous presentation file loaded into the builder.");
        } catch (error) {
            setAuthorMessage("Unable to read the uploaded presentation file.");
        }
    }

    async function resolvePreviousPresentation() {
        const trimmed = previousPresentationInput.trim();
        if (!trimmed) {
            return;
        }

        const parsed = safeJsonParse(trimmed);
        if (parsed) {
            return normalizeStoredArtifact(parsed);
        }

        if (isJwtLike(trimmed)) {
            const decoded = await api.decodeJwt(veramoEndpoint, trimmed);
            return normalizeStoredArtifact(decoded);
        }

        throw new Error("Previous presentation must be valid JSON or a JWT.");
    }

    async function fetchStatementCredentials() {
        try {
            const response = await api.listCredentialsByType(
                veramoEndpoint,
                "StatementVerifiableCredential",
            );
            setStatementCredentials(response || []);
            setAuthorMessage("Statement credentials loaded.");
        } catch (error) {
            setAuthorMessage("Unable to fetch statement credentials.");
        }
    }

    async function fetchPresentationHistory() {
        try {
            const response = await api.listPresentationsWithType(
                veramoEndpoint,
                "StatementSharing_VP",
            );
            setPresentationHistory(response || []);
            setAuthorMessage("Author presentation history loaded.");
        } catch (error) {
            setAuthorMessage("Unable to fetch author presentation history.");
        }
    }

    async function createPresentation() {
        if (!selectedDid || !hostURLPresentation) {
            setAuthorMessage("An active DID and host URL are required.");
            return;
        }

        const statementDocuments = selectedStatementIndexes
            .map((index) => normalizeStoredArtifact(statementCredentials[index]))
            .filter(Boolean);

        if (!statementDocuments.length) {
            setAuthorMessage("Select at least one statement credential.");
            return;
        }

        try {
            const attributes = {
                host_URL: hostURLPresentation,
                statement_vcs: statementDocuments,
                type: selectedTypePresentation.toLowerCase(),
            };

            if (selectedTypePresentation === "Origin") {
                if (!textOfStatement.trim()) {
                    setAuthorMessage(
                        "Origin presentations need the statement text.",
                    );
                    return;
                }

                const statementHash = await calculateHash(textOfStatement);
                attributes.hash_of_statement = statementHash;
                attributes.hashing_algo = "sha256";
                attributes.statement_text = textOfStatement;
            } else {
                const previousPresentation = await resolvePreviousPresentation();
                if (!previousPresentation) {
                    setAuthorMessage(
                        "Diffusion presentations need a previous presentation.",
                    );
                    return;
                }
                attributes.previous_presentation = previousPresentation;
                attributes.prev_vp_uuid = previousPresentation.id || "";
            }

            const response = await api.issueHolderClaimPresentation(veramoEndpoint, {
                assertion:
                    "This VP is submitted by the subject as evidence of VC propagation",
                attributes,
                holder: selectedDid,
                store: true,
                type: "StatementSharing_VP",
            });
            const decodedPresentation = await api.decodeJwt(veramoEndpoint, response.jwt);

            setLastPresentationResponse(response);
            setPresentationDocument(decodedPresentation);
            setSessionMessage("Author presentation created.");
            setPresentationHistory((previousHistory) => [
                decodedPresentation,
                ...previousHistory.filter(
                    (record) => normalizeStoredArtifact(record)?.id !== decodedPresentation?.id,
                ),
            ]);
            await renderReaderQr(
                response.jwt,
                "Presentation created. Reader verifier QR is ready.",
            );
        } catch (error) {
            setAuthorMessage("Unable to create the author presentation.");
        }
    }

    if (!selectedDid) {
        return (
            <EmptyState
                title="No active DID"
                description="Create or import a DID first."
            />
        );
    }

    return (
        <>
            <PageHero
                eyebrow="Author"
                title="Present"
            />

            <div className="page-grid">
                <SurfaceCard title="Vault">
                    <div className="button-row">
                        <button
                            className="secondary-button"
                            type="button"
                            onClick={fetchStatementCredentials}
                        >
                            Load statements
                        </button>
                        <button
                            className="secondary-button"
                            type="button"
                            onClick={fetchPresentationHistory}
                        >
                            Load history
                        </button>
                    </div>
                </SurfaceCard>

                <SurfaceCard
                    title="Presentation"
                    className="page-grid__wide"
                >
                    <div className="field-grid">
                        <label className="field">
                            <span className="field__label">Presentation Type</span>
                            <select
                                className="select-control"
                                onChange={(event) => setSelectedTypePresentation(event.target.value)}
                                value={selectedTypePresentation}
                            >
                                <option value="Origin">Origin</option>
                                <option value="Diffusion">Diffusion</option>
                            </select>
                        </label>
                        <label className="field">
                            <span className="field__label">Host URL</span>
                            <input
                                className="input-control"
                                onChange={(event) => setHostURLPresentation(event.target.value)}
                                value={hostURLPresentation}
                            />
                        </label>
                    </div>
                    <p className="record-item__meta">
                        Selected statement credentials: {selectedStatementIndexes.length}
                    </p>

                    {selectedTypePresentation === "Origin" ? (
                        <>
                            <label className="field field--wide">
                                <span className="field__label">Statement Text</span>
                                <textarea
                                    className="text-area"
                                    onChange={(event) => setTextOfStatement(event.target.value)}
                                    placeholder="Statement text"
                                    value={textOfStatement}
                                />
                            </label>
                        </>
                    ) : (
                        <>
                            <label className="field field--wide">
                                <span className="field__label">Previous Presentation</span>
                                <textarea
                                    className="text-area"
                                    onChange={(event) => setPreviousPresentationInput(event.target.value)}
                                    placeholder="Paste previous presentation JSON or JWT"
                                    value={previousPresentationInput}
                                />
                            </label>
                            <div className="file-upload">
                                <label className="upload-button">
                                    Upload JSON or JWT
                                    <input
                                        accept=".json,.jwt,.txt,application/json,text/plain"
                                        className="visually-hidden"
                                        onChange={loadPreviousPresentationFile}
                                        type="file"
                                    />
                                </label>
                                <p className="file-upload__meta">
                                    Paste text or upload a JSON/JWT file
                                </p>
                            </div>
                        </>
                    )}
                </SurfaceCard>

                <StatusCard message={authorMessage} />

                <SurfaceCard
                    title="Statement credential library"
                    className="page-grid__wide"
                >
                    <div className="record-stack">
                        {statementCredentials.length ? (
                            statementCredentials.map((credential, index) => (
                                <article
                                    className="record-item"
                                    draggable
                                    key={`${credential.hash}-${index}`}
                                    onDragStart={(event) =>
                                        startJsonDrag(
                                            event,
                                            normalizeStoredArtifact(credential),
                                        )
                                    }
                                >
                                    <div className="record-item__summary">
                                        <div>
                                            <p className="record-item__title">
                                                Statement VC #{index + 1}
                                            </p>
                                            <p className="record-item__meta">
                                                Selected:{" "}
                                                {selectedStatementIndexes.includes(index)
                                                    ? "Yes"
                                                    : "No"}
                                            </p>
                                        </div>
                                        <button
                                            className="secondary-button"
                                            type="button"
                                            onClick={() => toggleStatementSelection(index)}
                                        >
                                            {selectedStatementIndexes.includes(index)
                                                ? "Remove"
                                                : "Use"}
                                        </button>
                                        <button
                                            className="ghost-button"
                                            type="button"
                                            onClick={() => downloadArtifact("statement-vc", credential)}
                                        >
                                            Download JSON
                                        </button>
                                    </div>
                                    <p className="record-item__meta">
                                        Issuer:{" "}
                                        {credential?.verifiableCredential?.issuer?.id || "Unknown"}
                                    </p>
                                    <p className="record-item__meta">
                                        Holder:{" "}
                                        {credential?.verifiableCredential?.credentialSubject?.id || "Unknown"}
                                    </p>
                                    <DetailPanel label="Technical Details">
                                        <CodeView data={normalizeStoredArtifact(credential)} />
                                    </DetailPanel>
                                </article>
                            ))
                        ) : (
                            <p className="muted-copy">No statement credentials loaded yet.</p>
                        )}
                    </div>
                </SurfaceCard>

                <SurfaceCard
                    title="Reader handoff"
                >
                    <div className="button-row">
                        <button
                            className="secondary-button"
                            disabled={!presentationJwt}
                            type="button"
                            onClick={() =>
                                renderReaderQr(presentationJwt, "Reader verifier QR refreshed.")
                            }
                        >
                            Generate QR
                        </button>
                        <button
                            className="secondary-button"
                            disabled={!presentationDocument}
                            type="button"
                            onClick={() => downloadArtifact("statement-vp", presentationDocument)}
                        >
                            Download JSON
                        </button>
                        <button
                            className="ghost-button"
                            type="button"
                            onClick={() => {
                                setPresentationJwt("");
                                setPresentationDocument(null);
                                setPresentationQrImage("");
                            }}
                        >
                            Clear
                        </button>
                    </div>
                    {presentationDocument ? (
                        <article
                            className="record-item"
                            draggable
                            onDragStart={(event) => startJsonDrag(event, presentationDocument)}
                        >
                            <p className="record-item__title">
                                {presentationDocument?.attributes?.type || "presentation"}
                            </p>
                            <p className="record-item__meta">
                                Holder: {presentationDocument?.holder || "Unknown"}
                            </p>
                            <DetailPanel label="Technical Details">
                                <CodeView data={presentationDocument} />
                            </DetailPanel>
                        </article>
                    ) : (
                        <p className="muted-copy">
                            Create or load a presentation to produce a reader QR code.
                        </p>
                    )}
                    {presentationQrImage ? (
                        <div className="qr-preview">
                            <img
                                alt="Author presentation QR code"
                                src={`data:image/png;base64,${presentationQrImage}`}
                            />
                        </div>
                    ) : null}
                </SurfaceCard>

                <SurfaceCard
                    title="Presentation history"
                    className="page-grid__wide"
                >
                    <div className="record-stack">
                        {presentationHistory.length ? (
                            presentationHistory.map((record, index) => {
                                const presentation = normalizeStoredArtifact(record);
                                const jwt = presentation?.proof?.jwt || record?.jwt || "";
                                return (
                                    <article
                                        className="record-item"
                                        draggable
                                        key={`${index}-${presentation?.id || "presentation"}`}
                                        onDragStart={(event) => startJsonDrag(event, presentation)}
                                    >
                                        <div className="record-item__summary">
                                            <div>
                                                <p className="record-item__title">
                                                    {presentation?.attributes?.type || "presentation"}
                                                </p>
                                                <p className="record-item__meta">
                                                    Holder: {presentation?.holder || "Unknown"}
                                                </p>
                                                <p className="record-item__meta">
                                                    Statement credentials:{" "}
                                                    {presentation?.attributes?.statement_vcs?.length || 0}
                                                </p>
                                            </div>
                                            <button
                                                className="secondary-button"
                                                type="button"
                                                onClick={() =>
                                                    loadStoredPresentationIntoBuilder(presentation)
                                                }
                                            >
                                                Use previous
                                            </button>
                                            {jwt ? (
                                                <button
                                                    className="secondary-button"
                                                    type="button"
                                                    onClick={() =>
                                                        renderReaderQr(
                                                            jwt,
                                                            "Reader verifier QR generated from stored presentation.",
                                                        )
                                                    }
                                                >
                                                    Render QR
                                                </button>
                                            ) : null}
                                            <button
                                                className="ghost-button"
                                                type="button"
                                                onClick={() => downloadArtifact("statement-vp", presentation)}
                                            >
                                                Download JSON
                                            </button>
                                        </div>
                                        <p className="record-item__meta">
                                            Host URL:{" "}
                                            {presentation?.attributes?.host_URL || "Unavailable"}
                                        </p>
                                        <DetailPanel label="Technical Details">
                                            <CodeView data={presentation} />
                                        </DetailPanel>
                                    </article>
                                );
                            })
                        ) : (
                            <p className="muted-copy">No author presentations loaded yet.</p>
                        )}
                    </div>
                </SurfaceCard>
            </div>

            <StickyActions>
                <button className="primary-button" type="button" onClick={createPresentation}>
                    {selectedTypePresentation === "Origin" ? "Create origin" : "Create diffusion"}
                </button>
            </StickyActions>

            {lastPresentationResponse ? (
                <SurfaceCard title="Last response">
                    <DetailPanel label="Technical Details">
                        <CodeView data={lastPresentationResponse} />
                    </DetailPanel>
                </SurfaceCard>
            ) : null}
        </>
    );
}
