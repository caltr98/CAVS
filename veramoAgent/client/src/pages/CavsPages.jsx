import React, { useEffect, useState } from "react";
import { CodeView, DetailPanel, EmptyState, PageHero, StatusCard, StickyActions, SurfaceCard } from "../components/Shell";
import { useSession } from "../context/SessionContext";
import { api } from "../services/api";

const ROBERTA_NESTA_MODE = "RoBERTA + Nesta";
const GPT_COMPETENCE_MODE = "GPT competence service";
const QWEN_COMPETENCE_MODE = "Qwen competence service";
const DEEPSEEK_COMPETENCE_MODE = "DeepSeek competence service";
const DEFAULT_COMPETENCE_MODES = [
    ROBERTA_NESTA_MODE,
    GPT_COMPETENCE_MODE,
    QWEN_COMPETENCE_MODE,
    DEEPSEEK_COMPETENCE_MODE,
];

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
    if (mode === "qwen" || mode === QWEN_COMPETENCE_MODE || mode === "qwen_competence_service") {
        return QWEN_COMPETENCE_MODE;
    }
    if (mode === "deepseek" || mode === DEEPSEEK_COMPETENCE_MODE || mode === "deepseek_competence_service") {
        return DEEPSEEK_COMPETENCE_MODE;
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
    if (mode === QWEN_COMPETENCE_MODE) {
        return "qwen";
    }
    if (mode === DEEPSEEK_COMPETENCE_MODE) {
        return "deepseek";
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

function defaultOcrEndpointForOracleId(oracleId) {
    const parsed = parseInt(String(oracleId), 10);
    if (!Number.isInteger(parsed) || parsed < 0) {
        return "http://127.0.0.1:21000/requests";
    }
    return `http://127.0.0.1:${21000 + parsed}/requests`;
}

function oracleIdFromCavsEndpoint(endpoint) {
    try {
        const port = parseInt(new URL(endpoint).port, 10);
        const portToOracleId = {
            4200: 0,
            4202: 1,
            4203: 2,
            4204: 3,
        };
        return portToOracleId[port];
    } catch (error) {
        return undefined;
    }
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

export function CavsOcrOracleRegistryPage() {
    const {
        availableCavsEndpoints,
        selectedCavsEndpoint,
        setSelectedCavsEndpoint,
        setSessionMessage,
    } = useSession();
    const [oracleId, setOracleId] = useState("0");
    const [oracleEndpoint, setOracleEndpoint] = useState(defaultOcrEndpointForOracleId(0));
    const [contractRpcUrl, setContractRpcUrl] = useState("");
    const [contractAddress, setContractAddress] = useState("");
    const [contractDefaults, setContractDefaults] = useState(null);
    const [selectedCompetenceMode, setSelectedCompetenceMode] = useState(ROBERTA_NESTA_MODE);
    const [selectedCompetenceModes, setSelectedCompetenceModes] = useState(DEFAULT_COMPETENCE_MODES);
    const [feedback, setFeedback] = useState("Prepare the local oracle DID or update its fixed OCR coordinator slot.");
    const [busyAction, setBusyAction] = useState("");
    const [identity, setIdentity] = useState(null);
    const [registry, setRegistry] = useState(null);
    const [lastResponse, setLastResponse] = useState(null);

    useEffect(() => {
        let ignore = false;

        async function loadCompetenceMode() {
            if (!selectedCavsEndpoint) {
                return;
            }

            try {
                const data = await api.getCavsCompetenceModes(selectedCavsEndpoint);
                if (ignore) {
                    return;
                }
                setSelectedCompetenceModes(orderCompetenceModes(data.competence_modes));
                setSelectedCompetenceMode(
                    normalizeCompetenceModeForUi(data.selectedCompetenceMode),
                );
            } catch (error) {
                if (!ignore) {
                    setFeedback("Unable to load the active CAVS competence mode.");
                }
            }
        }

        loadCompetenceMode();

        return () => {
            ignore = true;
        };
    }, [selectedCavsEndpoint]);

    useEffect(() => {
        let ignore = false;

        async function loadRegistryDefaults() {
            if (!selectedCavsEndpoint) {
                return;
            }

            try {
                const data = await api.getOcrOracleRegistryDefaults(selectedCavsEndpoint);
                if (ignore) {
                    return;
                }
                setContractDefaults(data);
                if (data.rpcUrl) {
                    setContractRpcUrl(data.rpcUrl);
                }
                if (data.contractAddress) {
                    setContractAddress(data.contractAddress);
                }
            } catch (_error) {
                // Keep manual inputs if defaults are unavailable.
            }
        }

        loadRegistryDefaults();

        return () => {
            ignore = true;
        };
    }, [selectedCavsEndpoint]);

    useEffect(() => {
        const inferredOracleId = oracleIdFromCavsEndpoint(selectedCavsEndpoint);
        if (inferredOracleId === undefined) {
            return;
        }
        setOracleId(String(inferredOracleId));
        setOracleEndpoint(defaultOcrEndpointForOracleId(inferredOracleId));
    }, [selectedCavsEndpoint]);

    function parseOracleIdForPayload() {
        const parsed = parseInt(oracleId, 10);
        return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
    }

    function currentSlot() {
        const parsedOracleId = parseOracleIdForPayload();
        if (parsedOracleId === null || !registry?.oracles) {
            return null;
        }
        return registry.oracles.find((oracle) => Number(oracle.oracleId) === parsedOracleId) || null;
    }

    function slotBindingMessage() {
        const slot = currentSlot();
        if (!slot) {
            return "Load the coordinator registry to check the selected OCR slot.";
        }
        if (!slot.active) {
            return `Slot ${oracleId} is not registered in the fixed OCR deployment yet.`;
        }
        if (!identity?.eth_address) {
            return `Slot ${oracleId} is registered. Prepare identity to verify it matches this CAVS endpoint.`;
        }
        if (String(slot.account || "").toLowerCase() !== String(identity.eth_address).toLowerCase()) {
            return `Slot ${oracleId} belongs to ${slot.account}, not this CAVS endpoint signer ${identity.eth_address}.`;
        }
        if (identity.did && slot.did && identity.did !== slot.did) {
            return `Slot ${oracleId} uses the same signer but a different DID. Update the slot to align it.`;
        }
        if (slot.endpoint && slot.endpoint !== oracleEndpoint.trim()) {
            return `Slot ${oracleId} uses endpoint ${slot.endpoint}. Update the slot if this frontend endpoint is correct.`;
        }
        return `Slot ${oracleId} matches the selected CAVS signer and endpoint.`;
    }

    function validateRegistryInputs() {
        const parsedOracleId = parseOracleIdForPayload();
        if (parsedOracleId === null || !oracleEndpoint.trim()) {
            setFeedback("Oracle ID and public request endpoint are required.");
            return null;
        }
        if (!contractRpcUrl.trim() || !contractAddress.trim()) {
            setFeedback("Contract RPC URL and coordinator contract address are required.");
            return null;
        }
        return {
            oracleId: parsedOracleId,
            endpoint: oracleEndpoint.trim(),
            rpcUrl: contractRpcUrl.trim(),
            contractAddress: contractAddress.trim(),
        };
    }

    const rpcUrlLooksPrefilled =
        Boolean(contractDefaults?.rpcUrl) &&
        contractRpcUrl.trim() === String(contractDefaults.rpcUrl).trim();
    const contractAddressLooksPrefilled =
        Boolean(contractDefaults?.contractAddress) &&
        contractAddress.trim().toLowerCase() === String(contractDefaults.contractAddress).trim().toLowerCase();

    async function prepareIdentity() {
        if (!selectedCavsEndpoint) {
            setFeedback("Select a CAVS endpoint before preparing an oracle identity.");
            return;
        }
        const parsedOracleId = parseOracleIdForPayload();
        if (parsedOracleId === null) {
            setFeedback("Oracle ID must be a non-negative integer.");
            return;
        }

        setBusyAction("identity");
        try {
            const response = await api.getOcrOracleIdentity(selectedCavsEndpoint, {
                oracleId: parsedOracleId,
            });
            setIdentity(response);
            setLastResponse(response);
            setFeedback(`Oracle ${parsedOracleId} DID is ready: ${response.did}`);
            setSessionMessage(`OCR oracle ${parsedOracleId} identity ready.`);
        } catch (error) {
            setFeedback("Unable to prepare the OCR oracle identity.");
        } finally {
            setBusyAction("");
        }
    }

    async function loadRegistry() {
        if (!selectedCavsEndpoint) {
            setFeedback("Select a CAVS endpoint before loading the OCR registry.");
            return;
        }
        if (!contractRpcUrl.trim() || !contractAddress.trim()) {
            setFeedback("Contract RPC URL and coordinator contract address are required.");
            return;
        }

        setBusyAction("list");
        try {
            const response = await api.listOcrOracleRegistry(selectedCavsEndpoint, {
                rpcUrl: contractRpcUrl.trim(),
                contractAddress: contractAddress.trim(),
            });
            setRegistry(response);
            setLastResponse(response);
            setFeedback(`Loaded ${response.registeredOracleCount || 0} registered OCR oracle slots.`);
            setSessionMessage("OCR oracle registry loaded.");
        } catch (error) {
            setFeedback("Unable to load the OCR oracle registry.");
        } finally {
            setBusyAction("");
        }
    }

    async function updateOracleSlot() {
        if (!selectedCavsEndpoint) {
            setFeedback("Select a CAVS endpoint before updating an OCR slot.");
            return;
        }
        const payload = validateRegistryInputs();
        if (!payload) {
            return;
        }

        setBusyAction("update");
        try {
            const response = await api.updateOcrOracleSlot(selectedCavsEndpoint, payload);
            setIdentity({
                ok: true,
                oracleId: response.oracleId,
                did: response.did,
                eth_address: response.eth_address,
            });
            setRegistry(response.registry || registry);
            setLastResponse(response);
            setFeedback(`OCR slot ${response.oracleId} updated for the selected CAVS endpoint.`);
            setSessionMessage(`OCR slot ${response.oracleId} updated.`);
        } catch (error) {
            setFeedback("Unable to update the OCR oracle slot.");
        } finally {
            setBusyAction("");
        }
    }

    async function updateCompetenceMode() {
        if (!selectedCavsEndpoint) {
            setFeedback("Select a CAVS endpoint before updating competence mode.");
            return;
        }

        setBusyAction("mode");
        try {
            const response = await api.updateCavsConfig(selectedCavsEndpoint, {
                competenceMode: toBackendCompetenceMode(selectedCompetenceMode),
            });
            setLastResponse(response);
            setSelectedCompetenceMode(
                normalizeCompetenceModeForUi(
                    response.selectedCompetenceMode || selectedCompetenceMode,
                ),
            );
            setFeedback(`CAVS competence mode set to ${selectedCompetenceMode}.`);
            setSessionMessage("OCR CAVS competence mode updated.");
        } catch (error) {
            setFeedback("Unable to update the CAVS competence mode.");
        } finally {
            setBusyAction("");
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
                title="OCR Oracles"
            />

            <div className="page-grid">
                <SurfaceCard title="Oracle">
                    <label className="field field--wide">
                        <span className="field__label">Active CAVS Endpoint</span>
                        <input className="input-control input-control--readonly" value={selectedCavsEndpoint} readOnly />
                    </label>
                    <div className="chip-row">
                        {availableCavsEndpoints.map((endpoint) => (
                            <button
                                key={endpoint}
                                className={
                                    endpoint === selectedCavsEndpoint
                                        ? "endpoint-chip endpoint-chip--active"
                                        : "endpoint-chip"
                                }
                                type="button"
                                onClick={() => setSelectedCavsEndpoint(endpoint)}
                            >
                                {endpoint}
                            </button>
                        ))}
                    </div>
                    <div className="field-grid">
                        <label className="field">
                            <span className="field__label">Oracle ID</span>
                            <input
                                className="input-control"
                                value={oracleId}
                                onChange={(event) => setOracleId(event.target.value)}
                                placeholder="0"
                            />
                        </label>
                        <label className="field">
                            <span className="field__label">Public Request Endpoint</span>
                            <input
                                className="input-control"
                                value={oracleEndpoint}
                                onChange={(event) => setOracleEndpoint(event.target.value)}
                                placeholder="http://127.0.0.1:21000/requests"
                            />
                        </label>
                    </div>
                    <div className="button-row">
                        <button
                            className="secondary-button"
                            type="button"
                            onClick={() => setOracleEndpoint(defaultOcrEndpointForOracleId(oracleId))}
                        >
                            Use default endpoint
                        </button>
                        <button
                            className="secondary-button"
                            type="button"
                            onClick={prepareIdentity}
                            disabled={busyAction === "identity"}
                        >
                            {busyAction === "identity" ? "Preparing..." : "Prepare identity"}
                        </button>
                    </div>
                </SurfaceCard>

                <StatusCard message={feedback}>
                    <p className="muted-copy">
                        {slotBindingMessage()}
                    </p>
                </StatusCard>

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
                    <div className="button-row">
                        <button
                            className="secondary-button"
                            type="button"
                            onClick={updateCompetenceMode}
                            disabled={busyAction === "mode"}
                        >
                            {busyAction === "mode" ? "Saving..." : "Save mode"}
                        </button>
                    </div>
                </SurfaceCard>

                <SurfaceCard title="Coordinator Smart Contract" className="page-grid__wide">
                    <div className="field-grid">
                        <label className="field">
                            <span className="field__label">Contract RPC URL</span>
                            <input
                                className={
                                    rpcUrlLooksPrefilled
                                        ? "input-control input-control--prefilled"
                                        : "input-control"
                                }
                                value={contractRpcUrl}
                                onChange={(event) => setContractRpcUrl(event.target.value)}
                                placeholder="https://..."
                            />
                        </label>
                        <label className="field">
                            <span className="field__label">Contract Address</span>
                            <input
                                className={
                                    contractAddressLooksPrefilled
                                        ? "input-control input-control--prefilled"
                                        : "input-control"
                                }
                                value={contractAddress}
                                onChange={(event) => setContractAddress(event.target.value)}
                                placeholder="0x..."
                            />
                        </label>
                    </div>
                    <p className="muted-copy">
                        Defaults are loaded automatically from the local OCR environment and deployment registry when available.
                    </p>
                    <div className="button-row">
                        <button
                            className="secondary-button"
                            type="button"
                            onClick={loadRegistry}
                            disabled={busyAction === "list"}
                        >
                            {busyAction === "list" ? "Loading..." : "Load registry"}
                        </button>
                    </div>
                </SurfaceCard>

                {identity ? (
                    <SurfaceCard title="Identity" className="page-grid__wide">
                        <CodeView data={identity} />
                    </SurfaceCard>
                ) : null}

                {registry ? (
                    <SurfaceCard title="Registry" className="page-grid__wide">
                        <CodeView data={registry} />
                    </SurfaceCard>
                ) : null}
            </div>

            <StickyActions>
                <button
                    className="primary-button"
                    type="button"
                    onClick={updateOracleSlot}
                    disabled={busyAction === "update"}
                >
                    {busyAction === "update" ? "Updating..." : "Update OCR slot"}
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
