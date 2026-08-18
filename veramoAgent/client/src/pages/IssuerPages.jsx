import React, { useEffect, useState } from "react";
import { CodeView, DetailPanel, EmptyState, PageHero, StatusCard, StickyActions, SurfaceCard } from "../components/Shell";
import { useSession } from "../context/SessionContext";
import { api } from "../services/api";

function createSkillEntry(name, uri, payloadValue, source) {
    return {
        id: `${source}-${name}-${uri}`,
        key: `skill_${name}`,
        name,
        payloadValue,
        source,
        uri,
    };
}

function buildSkillsPayload(skillEntries) {
    return skillEntries.reduce((payload, entry) => {
        payload[entry.key] = entry.payloadValue;
        return payload;
    }, {});
}

function IssuerCredentialWorkspace({ mode }) {
    const {
        selectedDid,
        setSessionMessage,
        skillProcessorEndpoint,
        veramoEndpoint,
    } = useSession();

    const [holderDID, setHolderDID] = useState("");
    const [holderURL, setHolderURL] = useState("");
    const [certificateText, setCertificateText] = useState("");
    const [skillName, setSkillName] = useState("");
    const [skillUri, setSkillUri] = useState("");
    const [skillEntries, setSkillEntries] = useState([]);
    const [feedback, setFeedback] = useState(
        mode === "selective"
            ? "Ready to issue selective disclosure credentials."
            : "Ready to issue credentials.",
    );
    const [extractorEngines, setExtractorEngines] = useState([]);
    const [selectedExtractorEngine, setSelectedExtractorEngine] = useState("");
    const [skillEngines, setSkillEngines] = useState([]);
    const [selectedSkillEngine, setSelectedSkillEngine] = useState("");
    const [lastResult, setLastResult] = useState(null);

    useEffect(() => {
        let ignore = false;

        async function loadEngines() {
            try {
                const [extractorData, skillData] = await Promise.all([
                    api.getExtractorEngines(skillProcessorEndpoint),
                    api.getSkillEngines(skillProcessorEndpoint),
                ]);

                if (ignore) {
                    return;
                }

                const extractors = extractorData.extractor_engines || [];
                const skillOptions = skillData.skills_engines || [];
                setExtractorEngines(extractors);
                setSkillEngines(skillOptions);
                setSelectedExtractorEngine((current) => current || extractors[0] || "");
                setSelectedSkillEngine((current) => current || skillOptions[0] || "");
            } catch (error) {
                if (!ignore) {
                    setFeedback("Unable to load extractor options.");
                }
            }
        }

        loadEngines();

        return () => {
            ignore = true;
        };
    }, [skillProcessorEndpoint]);

    function addSkillEntry(entry) {
        setSkillEntries((previousEntries) => {
            if (previousEntries.some((existingEntry) => existingEntry.id === entry.id)) {
                return previousEntries;
            }
            return [...previousEntries, entry];
        });
    }

    function addManualSkill() {
        if (!skillName || !skillUri) {
            setFeedback("Provide both a skill name and URI before adding a manual skill.");
            return;
        }

        addSkillEntry(createSkillEntry(skillName, skillUri, `${skillName} ${skillUri}`, "manual"));
        setSkillName("");
        setSkillUri("");
        setFeedback("Manual skill added.");
    }

    async function extractSkillsAndAdd() {
        if (!certificateText) {
            setFeedback("Provide a certificate description before extracting skills.");
            return;
        }

        try {
            setFeedback("Extracting keywords and mapping them to skills...");
            const keywordResponse = await api.extractKeywords(skillProcessorEndpoint, {
                document: certificateText,
                engine: selectedExtractorEngine,
            });
            const keywords = keywordResponse.keyword || [];
            const skillResponse = await api.keywordToSkills(skillProcessorEndpoint, {
                keywords,
                engine: selectedSkillEngine,
            });
            const skillPairs = (skillResponse.skills || [])
                .map((match) => [match?.esco?.label, match?.esco?.uri])
                .filter(([label, uri]) => Boolean(label && uri));

            skillPairs.forEach(([label, uri]) => {
                addSkillEntry(createSkillEntry(label, uri, `${label}|${uri}`, "extracted"));
            });

            setFeedback(`Mapped ${skillPairs.length} skills from the certificate description.`);
        } catch (error) {
            setFeedback("Failed to extract skills from the certificate description.");
        }
    }

    function removeSkill(entryId) {
        setSkillEntries((previousEntries) =>
            previousEntries.filter((entry) => entry.id !== entryId),
        );
    }

    async function issueCredential() {
        if (!selectedDid || !holderDID || !holderURL) {
            setFeedback("Issuer DID, holder DID, and holder endpoint are required.");
            return;
        }

        const skillsPayload = buildSkillsPayload(skillEntries);

        try {
            if (mode === "selective") {
                const response = await api.issueSelectiveDisclosureCredential(veramoEndpoint, {
                    issuer: selectedDid,
                    holder: holderDID,
                    type: "SelectiveDisclosure_ESCO_type_VerifiableCredential",
                    attributes: skillsPayload,
                    store: false,
                });

                await api.storeSelectiveDisclosureVc(holderURL, {
                    vc: response.vc,
                    did: holderDID,
                    map: response.map,
                });

                setLastResult(response);
                setFeedback("Selective disclosure credential issued and delivered to the holder.");
                setSessionMessage("Selective disclosure credential issued.");
            } else {
                const response = await api.issueCredential(veramoEndpoint, {
                    issuer: selectedDid,
                    holder: holderDID,
                    type: "ESCO_type_VerifiableCredential",
                    attributes: { skills: skillsPayload },
                    store: false,
                });

                await api.storeVc(holderURL, {
                    did: holderDID,
                    verifiableCredential: response.jwt,
                });

                setLastResult(response);
                setFeedback("Credential issued and delivered to the holder.");
                setSessionMessage("Credential issued.");
            }

            setCertificateText("");
            setSkillEntries([]);
        } catch (error) {
            setFeedback("Failed to issue the credential.");
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

    const skillsPayload = buildSkillsPayload(skillEntries);

    return (
        <>
            <PageHero
                eyebrow="Issuer"
                title={
                    mode === "selective"
                        ? "Issue disclosure credential"
                        : "Issue credential"
                }
            />

            <div className="page-grid">
                <SurfaceCard title="Target">
                    <div className="field-grid">
                        <label className="field">
                            <span className="field__label">Issuer DID</span>
                            <input className="input-control" value={selectedDid} readOnly />
                        </label>
                        <label className="field">
                            <span className="field__label">Holder DID</span>
                            <input
                                className="input-control"
                                value={holderDID}
                                onChange={(event) => setHolderDID(event.target.value)}
                                placeholder="did:ethr:..."
                            />
                        </label>
                    </div>
                    <label className="field field--wide">
                        <span className="field__label">Holder Endpoint</span>
                        <input
                            className="input-control"
                            value={holderURL}
                            onChange={(event) => setHolderURL(event.target.value)}
                            placeholder="http://localhost:3001"
                        />
                    </label>
                </SurfaceCard>

                <StatusCard message={feedback}>
                    <p className="status-card__caption">
                        Current mode:{" "}
                        <strong>
                            {mode === "selective" ? "Selective disclosure issuance" : "Standard issuance"}
                        </strong>
                    </p>
                </StatusCard>

                <SurfaceCard
                    title="Skills from text"
                    className="page-grid__wide"
                >
                    <label className="field field--wide">
                        <span className="field__label">Certificate Description</span>
                        <textarea
                            className="text-area"
                            value={certificateText}
                            onChange={(event) => setCertificateText(event.target.value)}
                            placeholder="Certificate description"
                        />
                    </label>
                    <div className="field-grid">
                        <label className="field">
                            <span className="field__label">Keyword Extractor</span>
                            <select
                                className="select-control"
                                value={selectedExtractorEngine}
                                onChange={(event) => setSelectedExtractorEngine(event.target.value)}
                            >
                                {extractorEngines.map((engine) => (
                                    <option key={engine} value={engine}>
                                        {engine}
                                    </option>
                                ))}
                            </select>
                        </label>
                        <label className="field">
                            <span className="field__label">Skill Extractor</span>
                            <select
                                className="select-control"
                                value={selectedSkillEngine}
                                onChange={(event) => setSelectedSkillEngine(event.target.value)}
                            >
                                {skillEngines.map((engine) => (
                                    <option key={engine} value={engine}>
                                        {engine}
                                    </option>
                                ))}
                            </select>
                        </label>
                    </div>
                    <div className="button-row">
                        <button className="secondary-button" type="button" onClick={extractSkillsAndAdd}>
                            Extract skills
                        </button>
                    </div>
                </SurfaceCard>

                <SurfaceCard title="Manual skill">
                    <div className="field-grid">
                        <label className="field">
                            <span className="field__label">Skill Name</span>
                            <input
                                className="input-control"
                                value={skillName}
                                onChange={(event) => setSkillName(event.target.value)}
                            />
                        </label>
                        <label className="field">
                            <span className="field__label">Skill URI</span>
                            <input
                                className="input-control"
                                value={skillUri}
                                onChange={(event) => setSkillUri(event.target.value)}
                            />
                        </label>
                    </div>
                    <div className="button-row">
                        <button className="secondary-button" type="button" onClick={addManualSkill}>
                            Add skill
                        </button>
                    </div>
                </SurfaceCard>

                <SurfaceCard title="Skills">
                    <div className="record-stack">
                        {skillEntries.length ? (
                            skillEntries.map((entry) => (
                                <article key={entry.id} className="record-item">
                                    <div className="record-item__summary">
                                        <div>
                                            <p className="record-item__title">{entry.name}</p>
                                            <p className="record-item__meta">
                                                {entry.uri} / {entry.source}
                                            </p>
                                        </div>
                                        <button
                                            className="ghost-button"
                                            type="button"
                                            onClick={() => removeSkill(entry.id)}
                                        >
                                            Remove
                                        </button>
                                    </div>
                                </article>
                            ))
                        ) : (
                            <p className="muted-copy">No skills added yet.</p>
                        )}
                    </div>
                    <DetailPanel label="Technical Details">
                        <CodeView data={skillsPayload} />
                    </DetailPanel>
                </SurfaceCard>
            </div>

            <StickyActions>
                <button className="primary-button" type="button" onClick={issueCredential}>
                    {mode === "selective" ? "Issue disclosure" : "Issue credential"}
                </button>
            </StickyActions>

            {lastResult ? (
                <SurfaceCard title="Last result">
                    <DetailPanel label="Technical Details">
                        <CodeView data={lastResult} />
                    </DetailPanel>
                </SurfaceCard>
            ) : null}
        </>
    );
}

export function IssuerCreatePage() {
    return <IssuerCredentialWorkspace mode="standard" />;
}

export function IssuerSelectiveDisclosurePage() {
    return <IssuerCredentialWorkspace mode="selective" />;
}
