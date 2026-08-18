import axios from "axios";

const jsonHeaders = { "Content-Type": "application/json" };
const DEFAULT_TIMEOUT = 65000;
const LONG_TIMEOUT = 195000;
const STORE_TIMEOUT = 650000;
const TRACE_TIMEOUT = 120000;

function get(url, config = {}) {
    return axios.get(url, config).then(({ data }) => data);
}

function post(url, body, config = {}) {
    return axios
        .post(url, body, {
            headers: jsonHeaders,
            ...config,
        })
        .then(({ data }) => data);
}

function toBase64(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    let binary = "";
    bytes.forEach((byte) => {
        binary += String.fromCharCode(byte);
    });
    return btoa(binary);
}

export const api = {
    getOwnDids(veramoEndpoint) {
        return get(`${veramoEndpoint}/get_own_did`, { timeout: DEFAULT_TIMEOUT });
    },
    createDid(veramoEndpoint) {
        return get(`${veramoEndpoint}/create_did`, { timeout: DEFAULT_TIMEOUT });
    },
    importEthrDid(veramoEndpoint, { privateKey, walletAddress }) {
        return get(`${veramoEndpoint}/api/v0/setup`, {
            timeout: DEFAULT_TIMEOUT,
            params: {
                privatekey: privateKey,
                walletaddr: walletAddress,
            },
        });
    },
    async getQrCode(veramoEndpoint, jwt) {
        const response = await axios.post(
            `${veramoEndpoint}/get_qr_code/jwt`,
            { jwt },
            {
                responseType: "arraybuffer",
                timeout: DEFAULT_TIMEOUT,
            },
        );
        return toBase64(response.data);
    },
    storeVc(endpoint, payload) {
        return post(`${endpoint}/store_vc`, payload, { timeout: STORE_TIMEOUT });
    },
    storeStructuredVc(endpoint, payload) {
        return post(`${endpoint}/vc/store`, payload, { timeout: STORE_TIMEOUT });
    },
    storeSelectiveDisclosureVc(endpoint, payload) {
        return post(`${endpoint}/store_vc/selective_disclosure`, payload, {
            timeout: STORE_TIMEOUT,
        });
    },
    issueCredential(veramoEndpoint, payload) {
        return post(`${veramoEndpoint}/issue_verifiable_credential`, payload, {
            timeout: DEFAULT_TIMEOUT,
        });
    },
    issueSelectiveDisclosureCredential(veramoEndpoint, payload) {
        return post(
            `${veramoEndpoint}/issue_verifiable_credential/selective_disclosure`,
            payload,
            { timeout: 8000000 },
        );
    },
    issueSelectiveDisclosurePresentation(veramoEndpoint, payload) {
        return post(
            `${veramoEndpoint}/issue_verifiable_presentation/selective_disclosure`,
            payload,
            { timeout: LONG_TIMEOUT },
        );
    },
    issueHolderClaimPresentation(veramoEndpoint, payload) {
        return post(`${veramoEndpoint}/issue_verifiable_presentation/holder_claim`, payload, {
            timeout: DEFAULT_TIMEOUT,
        });
    },
    listCredentialsByType(veramoEndpoint, type) {
        return get(`${veramoEndpoint}/api/v0/list-verifiable-credentials-with-type`, {
            timeout: DEFAULT_TIMEOUT,
            params: { type },
        });
    },
    listSelectiveDisclosureCredentialsByType(veramoEndpoint, type) {
        return get(
            `${veramoEndpoint}/api/v0/list-verifiable-credentials-with-type/selective_disclosure`,
            {
                timeout: DEFAULT_TIMEOUT,
                params: { type },
            },
        );
    },
    listPresentationsWithType(veramoEndpoint, type) {
        return get(`${veramoEndpoint}/list_verifiable_presentations_with_type`, {
            timeout: DEFAULT_TIMEOUT,
            params: { type },
        });
    },
    decodeJwt(veramoEndpoint, jwt) {
        return get(`${veramoEndpoint}/decode_jwt`, {
            timeout: DEFAULT_TIMEOUT,
            params: { jwt },
        });
    },
    decodeJwtImage(veramoEndpoint, imageData) {
        return post(`${veramoEndpoint}/decode_jwt/image`, { img_data: imageData }, {
            timeout: 165000,
        });
    },
    verifyCredential(veramoEndpoint, credential) {
        return post(`${veramoEndpoint}/verify`, { credential }, { timeout: DEFAULT_TIMEOUT });
    },
    verifyMultiSignatureCredential(veramoEndpoint, vc) {
        return post(`${veramoEndpoint}/mi-vc/verify`, { vc }, { timeout: DEFAULT_TIMEOUT });
    },
    verifyPresentation(veramoEndpoint, vp) {
        return post(`${veramoEndpoint}/verify/vp`, { vp }, { timeout: DEFAULT_TIMEOUT });
    },
    verifyMultiSignaturePresentation(veramoEndpoint, vp, usePoO = true) {
        return post(`${veramoEndpoint}/vp/multi/verify`, { vp, usePoO }, {
            timeout: DEFAULT_TIMEOUT,
        });
    },
    configureIpfsSecrets(ipfsEndpoint, secret) {
        return get(`${ipfsEndpoint}/set_secrets`, {
            timeout: DEFAULT_TIMEOUT,
            params: {
                name: secret.name,
                psw: secret.password,
            },
        });
    },
    getPeerId(ipfsEndpoint) {
        return get(`${ipfsEndpoint}/peer_id`, { timeout: DEFAULT_TIMEOUT });
    },
    uploadText(ipfsEndpoint, text) {
        return post(`${ipfsEndpoint}/upload`, { text }, { timeout: TRACE_TIMEOUT });
    },
    retrieveByCid(ipfsEndpoint, cid) {
        return get(`${ipfsEndpoint}/retrieve`, {
            timeout: TRACE_TIMEOUT,
            params: { cid },
        });
    },
    getExtractorEngines(endpoint) {
        return get(`${endpoint}/api_extractor`, { timeout: DEFAULT_TIMEOUT });
    },
    getEnricherEngines(endpoint) {
        return get(`${endpoint}/api_enricher`, { timeout: DEFAULT_TIMEOUT });
    },
    getSkillEngines(endpoint) {
        return get(`${endpoint}/api_skills`, { timeout: DEFAULT_TIMEOUT });
    },
    extractKeywords(endpoint, params) {
        return get(`${endpoint}/extract`, {
            timeout: DEFAULT_TIMEOUT,
            params,
        });
    },
    keywordToSkills(endpoint, params) {
        return get(`${endpoint}/keyword_to_skills`, {
            timeout: DEFAULT_TIMEOUT * Math.max((params.keywords || []).length, 1),
            params,
        });
    },
    createStatementVc(endpoint, payload) {
        return post(`${endpoint}/api/vc`, payload, { timeout: LONG_TIMEOUT });
    },
    submitSelectiveDisclosureStatement(endpoint, payload) {
        return post(`${endpoint}/api/vc/selective_disclosure_issuing`, payload, {
            timeout: LONG_TIMEOUT,
        });
    },
    getCavsSkills(endpoint) {
        return get(`${endpoint}/api_skills`, { timeout: DEFAULT_TIMEOUT });
    },
    getCavsExtractorEngines(endpoint) {
        return get(`${endpoint}/api_extractor`, { timeout: DEFAULT_TIMEOUT });
    },
    getCavsEnricherEngines(endpoint) {
        return get(`${endpoint}/api_enricher`, { timeout: DEFAULT_TIMEOUT });
    },
    getCavsCompetenceModes(endpoint) {
        return get(`${endpoint}/api_competence_mode`, { timeout: DEFAULT_TIMEOUT });
    },
    getCavsOpenAiConfig(endpoint) {
        return get(`${endpoint}/api_openai_config`, { timeout: DEFAULT_TIMEOUT });
    },
    getCavsSelectiveDisclosureMode(endpoint) {
        return get(`${endpoint}/api_selective_disclosure_mode`, { timeout: DEFAULT_TIMEOUT });
    },
    updateCavsConfig(endpoint, payload) {
        return post(`${endpoint}/set_api`, payload, { timeout: DEFAULT_TIMEOUT });
    },
    setupCavsDid(endpoint) {
        return post(`${endpoint}/setup_did`, undefined, { timeout: DEFAULT_TIMEOUT });
    },
    addIssuerTrust(endpoint, payload) {
        return post(`${endpoint}/api/issuer_trust`, payload, { timeout: DEFAULT_TIMEOUT });
    },
    getOcrOracleIdentity(endpoint, payload) {
        return post(`${endpoint}/ocr/oracle_registry/identity`, payload, {
            timeout: DEFAULT_TIMEOUT,
        });
    },
    getOcrOracleRegistryDefaults(endpoint) {
        return get(`${endpoint}/ocr/oracle_registry/defaults`, {
            timeout: DEFAULT_TIMEOUT,
        });
    },
    listOcrOracleRegistry(endpoint, payload) {
        return post(`${endpoint}/ocr/oracle_registry/list`, payload, {
            timeout: DEFAULT_TIMEOUT,
        });
    },
    updateOcrOracleSlot(endpoint, payload) {
        return post(`${endpoint}/ocr/oracle_registry/update`, payload, {
            timeout: LONG_TIMEOUT,
        });
    },
    startAuthorOracleRequest(endpoint, payload) {
        return post(`${endpoint}/ocr/author_oracle_request/start`, payload, {
            timeout: DEFAULT_TIMEOUT,
        });
    },
    getAuthorOracleRequestStatus(endpoint, sessionId) {
        return get(`${endpoint}/ocr/author_oracle_request/status/${sessionId}`, {
            timeout: DEFAULT_TIMEOUT,
        });
    },
};
