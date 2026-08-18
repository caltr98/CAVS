import React, { createContext, useContext, useEffect, useState } from "react";
import config from "../config.json";
import { api } from "../services/api";

const SessionContext = createContext(null);

const availableCavsEndpoints = [
    config.cavsendpoint,
    config.cavsendpoint2,
    config.cavsendpoint3,
    config.cavsendpoint4,
].filter(Boolean);

const ipfsSecret = {
    name: import.meta.env.VITE_IPFS_SECRET_NAME || "",
    password: import.meta.env.VITE_IPFS_SECRET_PASSWORD || "",
};

export function SessionProvider({ children }) {
    const [availableDids, setAvailableDids] = useState([]);
    const [selectedDid, setSelectedDid] = useState("");
    const [selectedCavsEndpoint, setSelectedCavsEndpoint] = useState(
        availableCavsEndpoints[0] || "",
    );
    const [peerId, setPeerId] = useState("");
    const [sessionMessage, setSessionMessage] = useState("Booting workspace...");
    const [qrImage, setQrImage] = useState("");
    const [qrBusy, setQrBusy] = useState(false);
    const [didBusy, setDidBusy] = useState(false);

    useEffect(() => {
        let ignore = false;

        async function hydrateWallet() {
            try {
                const data = await api.getOwnDids(config.veramoagent);
                if (ignore) {
                    return;
                }
                const dids = data.dids || [];
                setAvailableDids(dids);
                setSelectedDid((previousDid) => {
                    if (dids.includes(previousDid)) {
                        return previousDid;
                    }
                    return dids[0] || "";
                });
                setSessionMessage(
                    dids.length
                        ? "Wallet ready. Switching actors keeps the active DID."
                        : "Wallet empty. Generate or import a DID to begin.",
                );
            } catch (error) {
                if (!ignore) {
                    setSessionMessage("Unable to load DIDs from the Veramo agent.");
                }
            }
        }

        hydrateWallet();

        return () => {
            ignore = true;
        };
    }, []);

    useEffect(() => {
        let ignore = false;

        async function hydrateIpfs() {
            try {
                if (ipfsSecret.name || ipfsSecret.password) {
                    await api.configureIpfsSecrets(config.ipfsagent, ipfsSecret);
                }
                const peerData = await api.getPeerId(config.ipfsagent);
                if (!ignore) {
                    setPeerId(peerData.peer_id || "");
                }
            } catch (error) {
                if (!ignore) {
                    setPeerId("");
                    setSessionMessage((previousMessage) =>
                        previousMessage.includes("Wallet")
                            ? previousMessage
                            : "IPFS agent unavailable. QR trace utilities may fail.",
                    );
                }
            }
        }

        hydrateIpfs();

        return () => {
            ignore = true;
        };
    }, []);

    async function refreshWallet() {
        const data = await api.getOwnDids(config.veramoagent);
        const dids = data.dids || [];
        setAvailableDids(dids);
        setSelectedDid((previousDid) => previousDid || dids[0] || "");
        return dids;
    }

    async function createDid() {
        setDidBusy(true);
        try {
            const response = await api.createDid(config.veramoagent);
            const createdDid = response.did;
            setAvailableDids((previousDids) =>
                previousDids.includes(createdDid)
                    ? previousDids
                    : [...previousDids, createdDid],
            );
            setSelectedDid(createdDid);
            setSessionMessage(`Created DID ${createdDid}`);
            return response;
        } catch (error) {
            setSessionMessage("Failed to create DID.");
            throw error;
        } finally {
            setDidBusy(false);
        }
    }

    async function importEthrDid({ privateKey, walletAddress }) {
        setDidBusy(true);
        try {
            const response = await api.importEthrDid(config.veramoagent, {
                privateKey,
                walletAddress,
            });
            const importedDid = response.did;
            setAvailableDids((previousDids) =>
                previousDids.includes(importedDid)
                    ? previousDids
                    : [...previousDids, importedDid],
            );
            setSelectedDid(importedDid);
            setSessionMessage(`Imported ETHR DID ${importedDid}`);
            return response;
        } catch (error) {
            setSessionMessage("Failed to import ETHR DID.");
            throw error;
        } finally {
            setDidBusy(false);
        }
    }

    async function fetchQrCode(jwt) {
        setQrBusy(true);
        try {
            const image = await api.getQrCode(config.veramoagent, jwt);
            setQrImage(image);
            setSessionMessage("JWT rendered as QR code.");
            return image;
        } catch (error) {
            setSessionMessage("Failed to render QR code.");
            throw error;
        } finally {
            setQrBusy(false);
        }
    }

    const value = {
        availableCavsEndpoints,
        availableDids,
        createDid,
        didBusy,
        fetchQrCode,
        importEthrDid,
        ipfsEndpoint: config.ipfsagent,
        peerId,
        qrBusy,
        qrImage,
        refreshWallet,
        selectedCavsEndpoint,
        selectedDid,
        sessionMessage,
        setQrImage,
        setSelectedCavsEndpoint,
        setSelectedDid,
        setSessionMessage,
        skillProcessorEndpoint: config.skillprocessor,
        veramoEndpoint: config.veramoagent,
    };

    return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession() {
    const context = useContext(SessionContext);
    if (!context) {
        throw new Error("useSession must be used inside SessionProvider");
    }
    return context;
}
