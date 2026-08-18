import React, { useEffect, useState } from "react";
import { CodeView, DetailPanel, EmptyState, PageHero, StatusCard, StickyActions, SurfaceCard } from "../components/Shell";
import { useSession } from "../context/SessionContext";
import { api } from "../services/api";

const ROBERTA_NESTA_MODE = "RoBERTA + Nesta";
const GPT_COMPETENCE_MODE = "GPT competence service";
const DEFAULT_COMPETENCE_MODES = [ROBERTA_NESTA_MODE, GPT_COMPETENCE_MODE];

function normalizeCompetenceModeForUi(mode) {
    if (mode === "RoBERTa to Nesta mode" || mode === "nesta" || mode === "ojd_daps") {
        return ROBERTA_NESTA_MODE;
    }
    if (
        mode === "gpt" ||
        mode === GPT_COMPETENCE_MODE ||
        mode === "gpt_competence_service" ||
        mode === "validation_gpt"
    ) {
        return GPT_COMPETENCE_MODE;
    }
    return mode || ROBERTA_NESTA_MODE;
}

function toBackendCompetenceMode(mode) {
    if (mode === ROBERTA_NESTA_MODE) {
        return "RoBERTa to Nesta mode";
    }
    if (mode === GPT_COMPETENCE_MODE) {
        return "gpt";
    }
    return mode;
}

function orderCompetenceModes(modes) {
    const normalizedModes = (modes && modes.length ? modes : DEFAULT_COMPETENCE_MODES)
        .map(normalizeCompetenceModeForUi);
    const uniqueModes = [...new Set(normalizedModes)];
    return [
        ...DEFAULT_COMPETENCE_MODES.filter((mode) => uniqueModes.includes(mode)),
        ...uniqueModes.filter((mode) => !DEFAULT_COMPETENCE_MODES.includes(mode)),
    ];
}

export function CavsConfigPage() {
    const { selectedCavsEndpoint, setSessionMessage } = useSession();
    const [selectedCompetenceMode, setSelectedCompetenceMode] = useState(ROBERTA_NESTA_MODE);
    const [selectedCompetenceModes, setSelectedCompetenceModes] = useState(DEFAULT_COMPETENCE_MODES);
    const [openAIApiKey, setOpenAIApiKey] = useState("");
    const [openAIBaseUrl, setOpenAIBaseUrl] = useState("");
    const [openAIModel, setOpenAIModel] = useState("");
    const [openAIApiKeyConfigured, setOpenAIApiKeyConfigured] = useState(false);
    const [openAIApiKeyMasked, setOpenAIApiKeyMasked] = useState("");
    const [feedback, setFeedback] = useState("Choose a CAVS endpoint in the session header.");
    const [lastResponse, setLastResponse] = useState(null);

    useEffect(() => {
        let ignore = false;

        async function loadConfig() {
            if (!selectedCavsEndpoint) {
                return;
            }

            try {
                const [competenceData, openAIData] = await Promise.all([
                    api.getCavsCompetenceModes(selectedCavsEndpoint),
                    api.getCavsOpenAiConfig(selectedCavsEndpoint),
                ]);

                if (ignore) {
                    return;
                }

                setSelectedCompetenceModes(orderCompetenceModes(competenceData.competence_modes));
                setSelectedCompetenceMode(
                    normalizeCompetenceModeForUi(competenceData.selectedCompetenceMode),
                );
                setOpenAIBaseUrl(openAIData.openAIBaseUrl || "");
                setOpenAIModel(openAIData.openAIModel || "");
                setOpenAIApiKeyConfigured(Boolean(openAIData.openAIApiKeyConfigured));
                setOpenAIApiKeyMasked(openAIData.openAIApiKeyMasked || "");
                setFeedback("Configuration loaded from the active CAVS endpoint.");
            } catch (error) {
                if (!ignore) {
                    setFeedback("Unable to load CAVS configuration from the active endpoint.");
                }
            }
        }

        loadConfig();

        return () => {
            ignore = true;
        };
    }, [selectedCavsEndpoint]);

    async function updateConfig() {
        if (!selectedCavsEndpoint) {
            setFeedback("Select a CAVS endpoint before updating config.");
            return;
        }

        try {
            const payload = {
                competenceMode: toBackendCompetenceMode(selectedCompetenceMode),
            };

            if (openAIApiKey.trim()) {
                payload.openAIApiKey = openAIApiKey.trim();
            }
            if (openAIBaseUrl.trim()) {
                payload.openAIBaseUrl = openAIBaseUrl.trim();
            }
            if (openAIModel.trim()) {
                payload.openAIModel = openAIModel.trim();
            }

            const response = await api.updateCavsConfig(selectedCavsEndpoint, payload);
            setLastResponse(response);
            setOpenAIApiKeyConfigured(Boolean(response.openAIApiKeyConfigured));
            setOpenAIApiKeyMasked(response.openAIApiKeyMasked || "");
            setOpenAIBaseUrl(response.openAIBaseUrl || "");
            setOpenAIModel(response.openAIModel || "");
            setOpenAIApiKey("");
            setSelectedCompetenceMode(
                normalizeCompetenceModeForUi(
                    response.selectedCompetenceMode || selectedCompetenceMode,
                ),
            );
            setFeedback(
                response.openAIConfigSync && response.openAIConfigSync.ok === false
                    ? "Config updated, but OpenAI service sync failed."
                    : "Configuration updated.",
            );
            setSessionMessage("CAVS configuration updated.");
        } catch (error) {
            setFeedback("Unable to update the CAVS configuration.");
        }
    }

    async function setupDid() {
        if (!selectedCavsEndpoint) {
            setFeedback("Select a CAVS endpoint before creating a DID.");
            return;
        }

        try {
            const response = await api.setupCavsDid(selectedCavsEndpoint);
            setLastResponse(response);
            setFeedback(`CAVS DID created: ${response.did}`);
            setSessionMessage(`CAVS DID created: ${response.did}`);
        } catch (error) {
            setFeedback("Unable to set up a DID on the selected CAVS instance.");
        }
    }

    if (!selectedCavsEndpoint) {
        return (
            <EmptyState
                title="No CAVS endpoint selected"
                description="Select a CAVS endpoint first."
            />
        );
    }

    return (
        <>
            <PageHero
                eyebrow="CAVS"
                title="Configure"
            />

            <div className="page-grid">
                <SurfaceCard title="Endpoint">
                    <label className="field field--wide">
                        <span className="field__label">Active CAVS Endpoint</span>
                        <input className="input-control" value={selectedCavsEndpoint} readOnly />
                    </label>
                    <div className="button-row">
                        <button className="secondary-button" type="button" onClick={setupDid}>
                            Setup DID
                        </button>
                    </div>
                </SurfaceCard>

                <StatusCard message={feedback} />

                <SurfaceCard title="Competence">
                    <div className="field-grid">
                        <label className="field">
                            <span className="field__label">Competence Mode</span>
                            <select
                                className="select-control"
                                value={selectedCompetenceMode}
                                onChange={(event) => setSelectedCompetenceMode(event.target.value)}
                            >
                                {selectedCompetenceModes.map((mode) => (
                                    <option key={mode} value={mode}>
                                        {mode}
                                    </option>
                                ))}
                            </select>
                        </label>
                    </div>
                </SurfaceCard>

                <SurfaceCard
                    title="OpenAI"
                    className="page-grid__wide"
                >
                    <div className="field-grid">
                        <label className="field">
                            <span className="field__label">OpenAI API Key</span>
                            <input
                                className="input-control"
                                type="password"
                                value={openAIApiKey}
                                onChange={(event) => setOpenAIApiKey(event.target.value)}
                                placeholder={
                                    openAIApiKeyConfigured
                                        ? "Stored key is already configured"
                                        : "Enter API key"
                                }
                            />
                        </label>
                        <label className="field">
                            <span className="field__label">OpenAI Base URL</span>
                            <input
                                className="input-control"
                                value={openAIBaseUrl}
                                onChange={(event) => setOpenAIBaseUrl(event.target.value)}
                                placeholder="Optional custom base URL"
                            />
                        </label>
                        <label className="field">
                            <span className="field__label">OpenAI Model</span>
                            <input
                                className="input-control"
                                value={openAIModel}
                                onChange={(event) => setOpenAIModel(event.target.value)}
                                placeholder="gpt-4.1"
                            />
                        </label>
                    </div>
                    <p className="muted-copy">
                        Current key state: {openAIApiKeyConfigured ? openAIApiKeyMasked || "configured" : "not configured"}
                    </p>
                </SurfaceCard>
            </div>

            <StickyActions>
                <button className="primary-button" type="button" onClick={updateConfig}>
                    Save
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

export function CavsIssuerTrustPage() {
    const { selectedCavsEndpoint, setSessionMessage } = useSession();
    const [issuerDid, setIssuerDid] = useState("");
    const [trustScore, setTrustScore] = useState("1");
    const [feedback, setFeedback] = useState("Rank a certificate issuer for the active CAVS endpoint.");
    const [lastResponse, setLastResponse] = useState(null);

    async function submitTrustScore() {
        if (!selectedCavsEndpoint || !issuerDid || !trustScore) {
            setFeedback("Issuer DID, trust score, and an active CAVS endpoint are required.");
            return;
        }

        try {
            const response = await api.addIssuerTrust(selectedCavsEndpoint, {
                did: issuerDid,
                rank: trustScore,
            });
            setLastResponse(response);
            setFeedback("Issuer trust score sent to CAVS.");
            setSessionMessage("Issuer trust score updated.");
        } catch (error) {
            setFeedback("Unable to update issuer trust.");
        }
    }

    if (!selectedCavsEndpoint) {
        return (
            <EmptyState
                title="No CAVS endpoint selected"
                description="Select a CAVS endpoint first."
            />
        );
    }

    return (
        <>
            <PageHero
                eyebrow="CAVS"
                title="Trust"
            />

            <div className="page-grid">
                <SurfaceCard title="Issuer">
                    <label className="field field--wide">
                        <span className="field__label">Active CAVS Endpoint</span>
                        <input className="input-control" value={selectedCavsEndpoint} readOnly />
                    </label>
                    <div className="field-grid">
                        <label className="field">
                            <span className="field__label">Issuer DID</span>
                            <input
                                className="input-control"
                                value={issuerDid}
                                onChange={(event) => setIssuerDid(event.target.value)}
                                placeholder="did:ethr:..."
                            />
                        </label>
                        <label className="field">
                            <span className="field__label">Trust Score [1-5]</span>
                            <input
                                className="input-control"
                                value={trustScore}
                                onChange={(event) => setTrustScore(event.target.value)}
                            />
                        </label>
                    </div>
                </SurfaceCard>

                <StatusCard message={feedback} />
            </div>

            <StickyActions>
                <button className="primary-button" type="button" onClick={submitTrustScore}>
                    Save trust
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
