import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
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

export function AuthorRequestPage() {
    const navigate = useNavigate();
    const {
        authorMessage,
        clearSelections,
        selectedCredentialIndexes,
        setAuthorMessage,
        setPendingDisclosureRequest,
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
            const [standardCredentials, selectiveCredentials] = await Promise.all([
                api.listCredentialsByType(veramoEndpoint, "ESCO_type_VerifiableCredential"),
                api.listSelectiveDisclosureCredentialsByType(
                    veramoEndpoint,
                    "SelectiveDisclosure_ESCO_type_VerifiableCredential",
                ),
            ]);
            setSkillsCredentials([...(standardCredentials || []), ...(selectiveCredentials || [])]);
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

            if (response.selectiveDisclosureRequest) {
                setPendingDisclosureRequest({
                    skillsToPresent:
                        response.selectiveDisclosureRequest.skills_extracted || [],
                    typeStatement: selectedTypeStatement,
                });
                setAuthorMessage(
                    "Selective disclosure requested. Continue in the selective disclosure page.",
                );
                navigate("/author/selective-disclosure");
                return;
            }

            setPendingDisclosureRequest(null);
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

export function AuthorSelectiveDisclosurePage() {
    const {
        authorMessage,
        pendingDisclosureRequest,
        resetDisclosureRequest,
        selectedCredentialIndexes,
        selectedSkillIndexes,
        setAuthorMessage,
        skillsCredentials,
        toggleCredentialIndex,
        toggleSkillIndex,
    } = useAuthorFlow();
    const { selectedCavsEndpoint, selectedDid, setSessionMessage, veramoEndpoint } = useSession();
    const [lastResponse, setLastResponse] = useState(null);

    const requestedSkills = pendingDisclosureRequest?.skillsToPresent || [];
    const disclosurePayloadPreview = selectedSkillIndexes.map(
        (index) => `skill_${requestedSkills[index]?.[0] || `skill-${index}`}`,
    );

    async function submitSelectiveDisclosure() {
        if (!pendingDisclosureRequest) {
            setAuthorMessage("Start from the request page to generate a selective disclosure request.");
            return;
        }
        if (!selectedDid || !selectedCavsEndpoint) {
            setAuthorMessage("A DID and CAVS endpoint are required.");
            return;
        }

        const credentialHashes = selectedCredentialIndexes.map(
            (index) => skillsCredentials[index]?.hash,
        );
        const attributesToDisclose = selectedSkillIndexes.map(
            (index) => `skill_${requestedSkills[index]?.[0]}`,
        );

        try {
            const vpResponse = await api.issueSelectiveDisclosurePresentation(veramoEndpoint, {
                attributesToDisclose,
                hashOfVCs: credentialHashes,
                holder: selectedDid,
                toStore: true,
                type: "VerifiablePresentation",
                typeStatement: pendingDisclosureRequest.typeStatement,
            });

            const response = await api.submitSelectiveDisclosureStatement(selectedCavsEndpoint, {
                holderDID: selectedDid,
                verifiableCredential: credentialHashes,
                vp: vpResponse.vp,
            });

            await api.storeVc(veramoEndpoint, {
                did: selectedDid,
                verifiableCredential: response.jwt,
            });

            setLastResponse({ response, vpResponse });
            resetDisclosureRequest();
            setAuthorMessage("Selective disclosure statement VC created and stored.");
            setSessionMessage("Selective disclosure statement VC stored.");
        } catch (error) {
            setAuthorMessage("Unable to complete the selective disclosure flow.");
        }
    }

    if (!pendingDisclosureRequest) {
        return (
            <EmptyState
                title="No pending selective disclosure request"
                description="Start with a statement request."
            />
        );
    }

    return (
        <>
            <PageHero
                eyebrow="Author"
                title="Disclosure"
            />

            <div className="page-grid">
                <SurfaceCard title="Requested skills">
                    <div className="record-stack">
                        {requestedSkills.map((keywordToSkill, index) => (
                            <article className="record-item" key={`${keywordToSkill[0]}-${index}`}>
                                <label className="checkbox-row">
                                    <input
                                        checked={selectedSkillIndexes.includes(index)}
                                        onChange={() => toggleSkillIndex(index)}
                                        type="checkbox"
                                    />
                                    <span>
                                        {keywordToSkill[0]} / {keywordToSkill[1]}
                                    </span>
                                </label>
                            </article>
                        ))}
                    </div>
                    <DetailPanel label="Technical Details">
                        <CodeView data={disclosurePayloadPreview} />
                    </DetailPanel>
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
                <button className="primary-button" type="button" onClick={submitSelectiveDisclosure}>
                    Send disclosure
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
        setAuthorMessage("Previous presentation loaded into the builder.");
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
                        <label className="field field--wide">
                            <span className="field__label">Previous Presentation</span>
                            <textarea
                                className="text-area"
                                onChange={(event) => setPreviousPresentationInput(event.target.value)}
                                placeholder="Previous presentation JSON or JWT"
                                value={previousPresentationInput}
                            />
                        </label>
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
