export function ensureArray(value) {
    if (Array.isArray(value)) {
        return value;
    }
    return value ? [value] : [];
}

export function isJwtLike(value) {
    if (typeof value !== "string") {
        return false;
    }
    const trimmed = value.trim();
    return trimmed.split(".").length === 3;
}

export function safeJsonParse(value) {
    try {
        return JSON.parse(value);
    } catch (error) {
        return null;
    }
}

export function normalizeStoredArtifact(record) {
    if (!record || typeof record !== "object") {
        return record;
    }
    if (record.verifiableCredential && typeof record.verifiableCredential === "object") {
        return record.verifiableCredential;
    }
    if (record.verifiablePresentation && typeof record.verifiablePresentation === "object") {
        return record.verifiablePresentation;
    }
    return record;
}

export function normalizeTypes(value) {
    return ensureArray(value).map(String);
}

export function isVerifiablePresentationDocument(record) {
    const document = normalizeStoredArtifact(record);
    const types = normalizeTypes(document?.type);
    return (
        types.includes("VerifiablePresentation") ||
        Boolean(document?.holder) ||
        Array.isArray(document?.verifiableCredential)
    );
}

export function isVerifiableCredentialDocument(record) {
    const document = normalizeStoredArtifact(record);
    const types = normalizeTypes(document?.type);
    return (
        types.includes("VerifiableCredential") ||
        Boolean(document?.credentialSubject) ||
        Boolean(document?.issuer)
    );
}

export function isMultiSignatureCredential(record) {
    const document = normalizeStoredArtifact(record);
    const types = normalizeTypes(document?.type);
    const proofTypes = normalizeTypes(document?.proof?.type);
    return (
        types.includes("aggregated-bls-multi-signature") ||
        proofTypes.some((type) => type.includes("aggregate-bls-multi-signature")) ||
        (Boolean(document?.aggregated_bls_public_key) && Boolean(document?.multi_issuers))
    );
}

export function isMultiSignaturePresentation(record) {
    const document = normalizeStoredArtifact(record);
    const proofTypes = normalizeTypes(document?.proof?.type);
    return (
        (Boolean(document?.aggregated_bls_public_key) && Boolean(document?.multi_holders)) ||
        proofTypes.some((type) => type.includes("aggregate-bls-multi-signature"))
    );
}

export function detectArtifact(record) {
    const document = normalizeStoredArtifact(record);

    if (isVerifiablePresentationDocument(document)) {
        if (isMultiSignaturePresentation(document)) {
            return {
                document,
                kind: "vp",
                verificationMode: "cavs-multisignature-vp",
                verificationLabel: "CAVS multisignature presentation",
            };
        }
        return {
            document,
            kind: "vp",
            verificationMode: "jwtproof2020-vp",
            verificationLabel: "JwtProof2020 presentation",
        };
    }

    if (isVerifiableCredentialDocument(document)) {
        if (isMultiSignatureCredential(document)) {
            return {
                document,
                kind: "vc",
                verificationMode: "cavs-multisignature-vc",
                verificationLabel: "CAVS multisignature credential",
            };
        }
        return {
            document,
            kind: "vc",
            verificationMode: "jwtproof2020-vc",
            verificationLabel: "JwtProof2020 credential",
        };
    }

    return {
        document,
        kind: "unknown",
        verificationMode: "unknown",
        verificationLabel: "Unknown document",
    };
}

export function extractEmbeddedStatementCredentials(record) {
    const document = normalizeStoredArtifact(record);
    const embedded =
        document?.attributes?.statement_vcs || document?.verifiableCredential || [];
    return ensureArray(embedded).map(normalizeStoredArtifact);
}

export function extractEmbeddedPresentationChain(record) {
    const chain = [];
    let current = normalizeStoredArtifact(record)?.attributes?.previous_presentation;

    while (current && typeof current === "object") {
        const normalized = normalizeStoredArtifact(current);
        chain.push(normalized);
        current = normalized?.attributes?.previous_presentation;
    }

    return chain;
}

export function createArtifactFilename(prefix, document) {
    const rawId =
        document?.id ||
        document?.credentialSubject?.id ||
        document?.credentialSubject?.statementHash ||
        document?.hash ||
        "document";
    const safeId = String(rawId).replace(/[^a-zA-Z0-9-_]+/g, "-").slice(0, 80);
    return `${prefix}-${safeId || "document"}.json`;
}

export function downloadJsonFile(filename, data) {
    const blob = new Blob([JSON.stringify(data, null, 2)], {
        type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename.endsWith(".json") ? filename : `${filename}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
}

export function startJsonDrag(event, data) {
    const serialized = JSON.stringify(data, null, 2);
    event.dataTransfer.effectAllowed = "copy";
    event.dataTransfer.setData("application/json", serialized);
    event.dataTransfer.setData("text/plain", serialized);
}
