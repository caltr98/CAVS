import React, { useState } from "react";
import {
    CodeView,
    DetailPanel,
    PageHero,
    StatusCard,
    SurfaceCard,
} from "../components/Shell";
import { useSession } from "../context/SessionContext";
import { api } from "../services/api";
import {
    createArtifactFilename,
    detectArtifact,
    downloadJsonFile,
    ensureArray,
    extractEmbeddedPresentationChain,
    extractEmbeddedStatementCredentials,
    isJwtLike,
    normalizeStoredArtifact,
    safeJsonParse,
    startJsonDrag,
} from "../utils/artifacts";

function formatVerificationValue(value) {
    if (value === true) {
        return "verified";
    }
    if (value === false) {
        return "not verified";
    }
    if (value === "error") {
        return "error";
    }
    return value || "Not verified";
}

function readFileAsText(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = reject;
        reader.readAsText(file);
    });
}

function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

async function resolveArtifactFromInput(veramoEndpoint, rawValue) {
    const trimmed = rawValue.trim();
    if (!trimmed) {
        throw new Error("Provide a credential, presentation, or JWT.");
    }

    const parsed = safeJsonParse(trimmed);
    if (parsed) {
        return normalizeStoredArtifact(parsed);
    }

    if (isJwtLike(trimmed)) {
        const decoded = await api.decodeJwt(veramoEndpoint, trimmed);
        return normalizeStoredArtifact(decoded);
    }

    throw new Error("Input must be valid JSON or a JWT.");
}

async function verifyArtifactDocument(veramoEndpoint, artifact) {
    const details = detectArtifact(artifact);

    if (details.verificationMode === "cavs-multisignature-vc") {
        const response = await api.verifyMultiSignatureCredential(veramoEndpoint, details.document);
        return {
            details,
            raw: response,
            verified: Boolean(response?.verified),
        };
    }

    if (details.verificationMode === "cavs-multisignature-vp") {
        const response = await api.verifyMultiSignaturePresentation(
            veramoEndpoint,
            details.document,
            true,
        );
        return {
            details,
            raw: response,
            verified: Boolean(response?.verified),
        };
    }

    if (details.verificationMode === "jwtproof2020-vc") {
        const response = await api.verifyCredential(veramoEndpoint, details.document);
        return {
            details,
            raw: response,
            verified: Boolean(response?.res),
        };
    }

    if (details.verificationMode === "jwtproof2020-vp") {
        const response = await api.verifyPresentation(veramoEndpoint, details.document);
        return {
            details,
            raw: response,
            verified: Boolean(response?.verified ?? response?.res),
        };
    }

    throw new Error("Unable to determine how to verify this document.");
}

function ArtifactRecordCard({
    artifact,
    downloadPrefix,
    extraActions = null,
    title,
    verificationText,
    onVerify,
}) {
    const document = normalizeStoredArtifact(artifact);

    return (
        <article
            className="record-item record-item--draggable"
            draggable
            onDragStart={(event) => startJsonDrag(event, document)}
        >
            <div className="record-item__summary">
                <div>
                    <p className="record-item__title">{title}</p>
                    <p className="record-item__meta">
                        {detectArtifact(document).verificationLabel}
                    </p>
                </div>
                <div className="button-row button-row--inline">
                    {onVerify ? (
                        <button className="secondary-button" type="button" onClick={onVerify}>
                            Verify
                        </button>
                    ) : null}
                    <button
                        className="ghost-button"
                        type="button"
                        onClick={() =>
                            downloadJsonFile(
                                createArtifactFilename(downloadPrefix, document),
                                document,
                            )
                        }
                    >
                        Download JSON
                    </button>
                    {extraActions}
                </div>
            </div>
            {document?.holder ? (
                <p className="record-item__meta">Holder: {document.holder}</p>
            ) : null}
            {document?.issuer?.id ? (
                <p className="record-item__meta">Issuer: {document.issuer.id}</p>
            ) : null}
            {document?.credentialSubject?.id ? (
                <p className="record-item__meta">
                    Subject: {document.credentialSubject.id}
                </p>
            ) : null}
            {verificationText ? (
                <p className="record-item__meta">
                    Verification result: {formatVerificationValue(verificationText)}
                </p>
            ) : null}
            <DetailPanel label="Technical Details">
                <CodeView data={document} />
            </DetailPanel>
        </article>
    );
}

function EmbeddedSkillsSection({
    credentials,
    label,
    onVerify,
    verificationResults,
    resultPrefix,
}) {
    if (!credentials.length) {
        return null;
    }

    return (
        <SurfaceCard title={label}>
            <div className="record-stack">
                {credentials.map((credential, index) => {
                    const resultKey = `${resultPrefix}-${index}`;
                    return (
                        <ArtifactRecordCard
                            artifact={credential}
                            downloadPrefix={resultPrefix}
                            key={`${resultKey}-${credential?.id || index}`}
                            onVerify={() => onVerify(credential, resultKey)}
                            title={`Credential #${index + 1}`}
                            verificationText={verificationResults[resultKey]}
                        />
                    );
                })}
            </div>
        </SurfaceCard>
    );
}

export function ReaderDecodeTracePage() {
    const { ipfsEndpoint, veramoEndpoint } = useSession();
    const [inputValue, setInputValue] = useState("");
    const [readData, setReadData] = useState("");
    const [feedback, setFeedback] = useState("Load JSON, JWT, or QR.");
    const [loadedArtifact, setLoadedArtifact] = useState(null);
    const [loadedArtifactDetails, setLoadedArtifactDetails] = useState(null);
    const [verificationSummary, setVerificationSummary] = useState(null);
    const [linkedPresentations, setLinkedPresentations] = useState([]);
    const [linkedCredentials, setLinkedCredentials] = useState([]);
    const [statementVerificationResults, setStatementVerificationResults] = useState({});
    const [embeddedSkillVerificationResults, setEmbeddedSkillVerificationResults] = useState({});
    const [sharingVerificationResults, setSharingVerificationResults] = useState({});
    const [dropActive, setDropActive] = useState(false);

    function applyLoadedArtifact(artifact, message) {
        const normalized = normalizeStoredArtifact(artifact);
        setLoadedArtifact(normalized);
        setLoadedArtifactDetails(detectArtifact(normalized));
        setVerificationSummary(null);
        setStatementVerificationResults({});
        setEmbeddedSkillVerificationResults({});
        setSharingVerificationResults({});
        setLinkedCredentials(extractEmbeddedStatementCredentials(normalized));
        setLinkedPresentations(extractEmbeddedPresentationChain(normalized));
        setFeedback(message);
    }

    async function loadFromText(rawValue = inputValue) {
        try {
            const artifact = await resolveArtifactFromInput(veramoEndpoint, rawValue);
            applyLoadedArtifact(artifact, "Document loaded.");
        } catch (error) {
            setFeedback(error?.message || "Unable to load the document.");
        }
    }

    async function decodeFromImage(encodedImage = readData) {
        if (!encodedImage) {
            setFeedback("Drop or upload a QR image before decoding.");
            return;
        }

        try {
            const response = await api.decodeJwtImage(veramoEndpoint, encodedImage);
            const normalized = normalizeStoredArtifact(response);
            setInputValue(JSON.stringify(normalized, null, 2));
            applyLoadedArtifact(normalized, "QR code decoded.");
        } catch (error) {
            setFeedback("Unable to decode the QR image.");
        }
    }

    async function verifyLoadedArtifact() {
        if (!loadedArtifact) {
            return;
        }

        try {
            const result = await verifyArtifactDocument(veramoEndpoint, loadedArtifact);
            setVerificationSummary(result);
            setFeedback(
                result.verified
                    ? `${result.details.verificationLabel} verified.`
                    : `${result.details.verificationLabel} did not verify.`,
            );
        } catch (error) {
            setVerificationSummary({
                details: loadedArtifactDetails,
                raw: error?.message || "error",
                verified: false,
            });
            setFeedback(error?.message || "Unable to verify the document.");
        }
    }

    async function verifyLinkedCredential(artifact, resultKey) {
        try {
            const result = await verifyArtifactDocument(veramoEndpoint, artifact);
            setStatementVerificationResults((previousResults) => ({
                ...previousResults,
                [resultKey]: result.verified ? "verified" : "not verified",
            }));
        } catch (error) {
            setStatementVerificationResults((previousResults) => ({
                ...previousResults,
                [resultKey]: "error",
            }));
        }
    }

    async function verifyEmbeddedSkill(credential, resultKey) {
        try {
            const result = await verifyArtifactDocument(veramoEndpoint, credential);
            setEmbeddedSkillVerificationResults((previousResults) => ({
                ...previousResults,
                [resultKey]: result.verified ? "verified" : "not verified",
            }));
        } catch (error) {
            setEmbeddedSkillVerificationResults((previousResults) => ({
                ...previousResults,
                [resultKey]: "error",
            }));
        }
    }

    async function verifyLinkedPresentation(artifact, resultKey) {
        try {
            const result = await verifyArtifactDocument(veramoEndpoint, artifact);
            setSharingVerificationResults((previousResults) => ({
                ...previousResults,
                [resultKey]: result.verified ? "verified" : "not verified",
            }));
        } catch (error) {
            setSharingVerificationResults((previousResults) => ({
                ...previousResults,
                [resultKey]: "error",
            }));
        }
    }

    async function traceLinkedEvidence() {
        if (!loadedArtifact) {
            return;
        }

        const embeddedCredentials = extractEmbeddedStatementCredentials(loadedArtifact);
        const embeddedPresentations = extractEmbeddedPresentationChain(loadedArtifact);

        if (embeddedCredentials.length || embeddedPresentations.length) {
            setLinkedCredentials(embeddedCredentials);
            setLinkedPresentations(embeddedPresentations);
            setFeedback("Linked evidence loaded from the presentation.");
            return;
        }

        if (
            ipfsEndpoint &&
            loadedArtifact?.attributes?.url_or_cid_jwt_prev &&
            loadedArtifact?.attributes?.prev_vp_uuid
        ) {
            try {
                let current = loadedArtifact;
                const history = [];

                while (
                    current &&
                    current.attributes?.type !== "origin" &&
                    current.attributes?.url_or_cid_jwt_prev &&
                    current.attributes?.prev_vp_uuid
                ) {
                    const fetched = await api.retrieveByCid(
                        ipfsEndpoint,
                        current.attributes.url_or_cid_jwt_prev,
                    );
                    const previousJwt =
                        JSON.parse(fetched.result)[current.attributes.prev_vp_uuid];
                    const previous = await api.decodeJwt(veramoEndpoint, previousJwt);
                    history.push(normalizeStoredArtifact(previous));
                    current = previous;
                }

                setLinkedPresentations(history);
                setFeedback("Linked evidence loaded from optional IPFS references.");
                return;
            } catch (error) {
                setFeedback("Unable to load linked evidence from IPFS.");
                return;
            }
        }

        setFeedback("No linked evidence found in the loaded document.");
    }

    async function handleDroppedPayload(event) {
        event.preventDefault();
        setDropActive(false);

        const droppedFile = event.dataTransfer.files?.[0];
        if (droppedFile) {
            if (droppedFile.type.startsWith("image/")) {
                const imageDataUrl = await readFileAsDataUrl(droppedFile);
                const encodedImage = imageDataUrl.replace(/^data:image\/\w+;base64,/, "");
                setReadData(encodedImage);
                await decodeFromImage(encodedImage);
                return;
            }

            const fileText = await readFileAsText(droppedFile);
            setInputValue(fileText);
            await loadFromText(fileText);
            return;
        }

        const droppedText =
            event.dataTransfer.getData("application/json") ||
            event.dataTransfer.getData("text/plain");

        if (droppedText) {
            setInputValue(droppedText);
            await loadFromText(droppedText);
        }
    }

    return (
        <>
            <PageHero
                eyebrow="Reader"
                title="Verify"
            />

            <div className="page-grid">
                <SurfaceCard
                    className="page-grid__wide"
                    title="Input"
                >
                    <label className="field field--wide">
                        <span className="field__label">Credential or Presentation</span>
                        <div
                            className={
                                dropActive
                                    ? "artifact-dropzone artifact-dropzone--active"
                                    : "artifact-dropzone"
                            }
                            onDragEnter={() => setDropActive(true)}
                            onDragLeave={() => setDropActive(false)}
                            onDragOver={(event) => {
                                event.preventDefault();
                                setDropActive(true);
                            }}
                            onDrop={handleDroppedPayload}
                        >
                            <textarea
                                className="text-area artifact-dropzone__textarea"
                                onChange={(event) => setInputValue(event.target.value)}
                                placeholder="Paste JSON, a JWT, or drop a file."
                                value={inputValue}
                            />
                        </div>
                    </label>
                    <div className="file-upload">
                        <label className="upload-button">
                            Upload QR
                            <input
                                accept="image/*"
                                className="visually-hidden"
                                onChange={async (event) => {
                                    const file = event.target.files?.[0];
                                    if (!file) {
                                        return;
                                    }
                                    const imageDataUrl = await readFileAsDataUrl(file);
                                    setReadData(
                                        imageDataUrl.replace(/^data:image\/\w+;base64,/, ""),
                                    );
                                }}
                                type="file"
                            />
                        </label>
                        <p className="file-upload__meta">
                            {readData ? "QR ready" : "PNG or JPG"}
                        </p>
                    </div>
                    <div className="button-row">
                        <button className="secondary-button" type="button" onClick={() => loadFromText()}>
                            Load
                        </button>
                        <button className="secondary-button" type="button" onClick={() => decodeFromImage()}>
                            Decode QR
                        </button>
                        <button className="ghost-button" type="button" onClick={traceLinkedEvidence}>
                            Linked evidence
                        </button>
                    </div>
                </SurfaceCard>

                <StatusCard message={feedback} />

                {loadedArtifact ? (
                    <SurfaceCard
                        className="page-grid__wide"
                        title="Loaded document"
                    >
                        <ArtifactRecordCard
                            artifact={loadedArtifact}
                            downloadPrefix="reader-document"
                            onVerify={verifyLoadedArtifact}
                            title={
                                loadedArtifactDetails?.kind === "vc"
                                    ? "Loaded credential"
                                    : "Loaded presentation"
                            }
                            verificationText={
                                verificationSummary
                                    ? verificationSummary.verified
                                        ? "verified"
                                        : "not verified"
                                    : ""
                            }
                        />
                        {verificationSummary ? (
                            <DetailPanel label="Verification Response">
                                <CodeView data={verificationSummary.raw} />
                            </DetailPanel>
                        ) : null}
                    </SurfaceCard>
                ) : null}
            </div>

            {linkedCredentials.length ? (
                <div className="page-grid">
                    {linkedCredentials.map((artifact, index) => {
                        const document = normalizeStoredArtifact(artifact);
                        const directSkills = ensureArray(
                            document?.credentialSubject?.credentials_for_skills,
                        );
                        const similarSkills = ensureArray(
                            document?.credentialSubject?.credentials_for_similar_concepts_skills,
                        );
                        const generalSkills = ensureArray(
                            document?.credentialSubject?.credentials_for_general_concepts_skills,
                        );

                        return (
                            <SurfaceCard
                                className="page-grid__wide"
                                key={`${document?.id || "statement"}-${index}`}
                                title={`Linked statement VC #${index + 1}`}
                            >
                                <ArtifactRecordCard
                                    artifact={document}
                                    downloadPrefix="linked-statement-vc"
                                    onVerify={() => verifyLinkedCredential(document, index)}
                                    title={`Statement VC #${index + 1}`}
                                    verificationText={statementVerificationResults[index]}
                                />
                                <EmbeddedSkillsSection
                                    credentials={directSkills}
                                    label="Embedded skill credentials"
                                    onVerify={verifyEmbeddedSkill}
                                    resultPrefix={`direct-${index}`}
                                    verificationResults={embeddedSkillVerificationResults}
                                />
                                <EmbeddedSkillsSection
                                    credentials={similarSkills}
                                    label="Embedded similar-concept credentials"
                                    onVerify={verifyEmbeddedSkill}
                                    resultPrefix={`similar-${index}`}
                                    verificationResults={embeddedSkillVerificationResults}
                                />
                                <EmbeddedSkillsSection
                                    credentials={generalSkills}
                                    label="Embedded higher-concept credentials"
                                    onVerify={verifyEmbeddedSkill}
                                    resultPrefix={`general-${index}`}
                                    verificationResults={embeddedSkillVerificationResults}
                                />
                            </SurfaceCard>
                        );
                    })}
                </div>
            ) : null}

            {linkedPresentations.length ? (
                <SurfaceCard title="Linked presentation chain">
                    <div className="record-stack">
                        {linkedPresentations.map((artifact, index) => (
                            <ArtifactRecordCard
                                artifact={artifact}
                                downloadPrefix="linked-presentation"
                                key={`${artifact?.id || "vp"}-${index}`}
                                onVerify={() =>
                                    verifyLinkedPresentation(artifact, index)
                                }
                                title={`Chain node #${index + 1}`}
                                verificationText={sharingVerificationResults[index]}
                            />
                        ))}
                    </div>
                </SurfaceCard>
            ) : null}
        </>
    );
}

export function ReaderHistoryPage() {
    const { veramoEndpoint } = useSession();
    const [feedback, setFeedback] = useState("Load stored presentations.");
    const [history, setHistory] = useState([]);

    async function fetchVerifiablePresentations() {
        try {
            const response = await api.listPresentationsWithType(
                veramoEndpoint,
                "StatementSharing_VP",
            );
            setHistory((response || []).map(normalizeStoredArtifact));
            setFeedback("Presentation history loaded.");
        } catch (error) {
            setFeedback("Unable to fetch presentation history.");
        }
    }

    return (
        <>
            <PageHero
                eyebrow="Reader"
                title="History"
            />

            <div className="page-grid">
                <SurfaceCard title="History">
                    <div className="button-row">
                        <button
                            className="secondary-button"
                            type="button"
                            onClick={fetchVerifiablePresentations}
                        >
                            Load history
                        </button>
                    </div>
                </SurfaceCard>
                <StatusCard message={feedback} />
                <SurfaceCard
                    className="page-grid__wide"
                    title="Stored presentations"
                >
                    <div className="record-stack">
                        {history.length ? (
                            history.map((artifact, index) => (
                                <ArtifactRecordCard
                                    artifact={artifact}
                                    downloadPrefix="reader-history"
                                    key={`${artifact?.id || "history"}-${index}`}
                                    title={
                                        artifact?.attributes?.type || `Presentation #${index + 1}`
                                    }
                                />
                            ))
                        ) : (
                            <p className="muted-copy">No presentations loaded yet.</p>
                        )}
                    </div>
                </SurfaceCard>
            </div>
        </>
    );
}
