import React, { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { actorNavigation, getActorNavigation } from "../navigation";
import { useSession } from "../context/SessionContext";

function navClassName({ isActive }) {
    return isActive ? "nav-pill nav-pill--active" : "nav-pill";
}

export function SurfaceCard({ title, subtitle, children, className = "" }) {
    return (
        <section className={`surface-card ${className}`.trim()}>
            {(title || subtitle) && (
                <div className="surface-card__header">
                    {title ? <h2 className="surface-card__title">{title}</h2> : null}
                    {subtitle ? <p className="surface-card__subtitle">{subtitle}</p> : null}
                </div>
            )}
            {children}
        </section>
    );
}

export function PageHero({ eyebrow, title, description }) {
    return (
        <header className="page-hero">
            {eyebrow ? <p className="page-hero__eyebrow">{eyebrow}</p> : null}
            <h1 className="page-hero__title">{title}</h1>
            {description ? <p className="page-hero__description">{description}</p> : null}
        </header>
    );
}

export function StatusCard({ title = "Status", message, tone = "info", children }) {
    return (
        <SurfaceCard className={`status-card status-card--${tone}`} title={title}>
            <p className="status-card__message">{message}</p>
            {children}
        </SurfaceCard>
    );
}

export function DetailPanel({ label, children, defaultOpen = false }) {
    return (
        <details className="detail-panel" open={defaultOpen}>
            <summary>
                <span className="detail-panel__label">{label}</span>
                <span className="detail-panel__hint" aria-hidden="true" />
            </summary>
            <div className="detail-panel__body">{children}</div>
        </details>
    );
}

export function CodeView({ data }) {
    const value = typeof data === "string" ? data : JSON.stringify(data, null, 2);
    return <pre className="code-view">{value}</pre>;
}

export function StickyActions({ children }) {
    return <div className="sticky-actions">{children}</div>;
}

export function EmptyState({ title, description, children }) {
    return (
        <SurfaceCard className="empty-state">
            <h2 className="empty-state__title">{title}</h2>
            <p className="empty-state__description">{description}</p>
            {children}
        </SurfaceCard>
    );
}

function SessionHeader() {
    const {
        availableCavsEndpoints,
        availableDids,
        createDid,
        didBusy,
        fetchQrCode,
        importEthrDid,
        peerId,
        qrBusy,
        qrImage,
        selectedCavsEndpoint,
        selectedDid,
        sessionMessage,
        setQrImage,
        setSelectedCavsEndpoint,
        setSelectedDid,
        veramoEndpoint,
    } = useSession();

    const [customCavsEndpoint, setCustomCavsEndpoint] = useState(selectedCavsEndpoint);
    const [walletAddress, setWalletAddress] = useState("");
    const [privateKey, setPrivateKey] = useState("");
    const [qrJwt, setQrJwt] = useState("");
    const [headerMessage, setHeaderMessage] = useState("");

    useEffect(() => {
        setCustomCavsEndpoint(selectedCavsEndpoint);
    }, [selectedCavsEndpoint]);

    async function handleCreateDid() {
        try {
            await createDid();
            setHeaderMessage("New DID added to the wallet.");
        } catch (error) {
            setHeaderMessage("Unable to create DID.");
        }
    }

    async function handleImportDid() {
        try {
            await importEthrDid({ privateKey, walletAddress });
            setWalletAddress("");
            setPrivateKey("");
            setHeaderMessage("ETHR DID imported.");
        } catch (error) {
            setHeaderMessage("Unable to import ETHR DID.");
        }
    }

    async function handleQrRender() {
        try {
            await fetchQrCode(qrJwt);
            setHeaderMessage("QR code generated.");
        } catch (error) {
            setHeaderMessage("Unable to generate QR code.");
        }
    }

    function applyPresetEndpoint(endpoint) {
        setSelectedCavsEndpoint(endpoint);
        setCustomCavsEndpoint(endpoint);
    }

    return (
        <section className="session-tools">
            <div className="session-bar">
                <label className="session-field">
                    <span className="field__label">DID</span>
                    <select
                        className="select-control"
                        value={selectedDid}
                        onChange={(event) => setSelectedDid(event.target.value)}
                    >
                        {availableDids.map((did) => (
                            <option key={did} value={did}>
                                {did}
                            </option>
                        ))}
                    </select>
                </label>
                <label className="session-field">
                    <span className="field__label">CAVS</span>
                    <input className="input-control" value={selectedCavsEndpoint} readOnly />
                </label>
                <div className="session-status">
                    <span className="status-inline__dot" />
                    <span>{headerMessage || sessionMessage}</span>
                </div>
                <button
                    className="primary-button"
                    type="button"
                    onClick={handleCreateDid}
                    disabled={didBusy}
                >
                    {didBusy ? "Working..." : "New DID"}
                </button>
            </div>

            <div className="session-panels">
                <DetailPanel label="Wallet">
                    <div className="field-grid">
                        <label className="field">
                            <span className="field__label">Veramo</span>
                            <input className="input-control" value={veramoEndpoint} readOnly />
                        </label>
                        <label className="field">
                            <span className="field__label">Peer</span>
                            <input className="input-control" value={peerId || "Unavailable"} readOnly />
                        </label>
                    </div>
                    <div className="field-grid">
                        <label className="field">
                            <span className="field__label">Wallet Address</span>
                            <input
                                className="input-control"
                                value={walletAddress}
                                onChange={(event) => setWalletAddress(event.target.value)}
                                placeholder="0x..."
                            />
                        </label>
                        <label className="field">
                            <span className="field__label">Private Key</span>
                            <input
                                className="input-control"
                                value={privateKey}
                                onChange={(event) => setPrivateKey(event.target.value)}
                                placeholder="0x..."
                            />
                        </label>
                    </div>
                    <div className="button-row">
                        <button className="secondary-button" type="button" onClick={handleImportDid}>
                            Import DID
                        </button>
                    </div>
                </DetailPanel>

                <DetailPanel label="Endpoint">
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
                                onClick={() => applyPresetEndpoint(endpoint)}
                            >
                                {endpoint}
                            </button>
                        ))}
                    </div>
                    <label className="field field--wide">
                        <span className="field__label">Custom endpoint</span>
                        <input
                            className="input-control"
                            value={customCavsEndpoint}
                            onChange={(event) => setCustomCavsEndpoint(event.target.value)}
                            placeholder="http://localhost:4200"
                        />
                    </label>
                    <div className="button-row">
                        <button
                            className="secondary-button"
                            type="button"
                            onClick={() => setSelectedCavsEndpoint(customCavsEndpoint)}
                        >
                            Apply
                        </button>
                    </div>
                </DetailPanel>

                <DetailPanel label="QR">
                    <label className="field field--wide">
                        <span className="field__label">JWT</span>
                        <textarea
                            className="text-area"
                            value={qrJwt}
                            onChange={(event) => setQrJwt(event.target.value)}
                            placeholder="Paste JWT"
                        />
                    </label>
                    <div className="button-row">
                        <button
                            className="secondary-button"
                            type="button"
                            onClick={handleQrRender}
                            disabled={qrBusy}
                        >
                            {qrBusy ? "Rendering..." : "Generate QR"}
                        </button>
                        <button
                            className="ghost-button"
                            type="button"
                            onClick={() => {
                                setQrJwt("");
                                setQrImage("");
                            }}
                        >
                            Clear
                        </button>
                    </div>
                    {qrImage ? (
                        <div className="qr-preview">
                            <img alt="JWT QR Code" src={`data:image/png;base64,${qrImage}`} />
                        </div>
                    ) : null}
                </DetailPanel>
            </div>
        </section>
    );
}

export function AppShell() {
    const location = useLocation();
    const activeActor = getActorNavigation(location.pathname);

    return (
        <div className="app-shell">
            <header className="shell-banner">
                <div>
                    <h1 className="shell-banner__title">CAVS</h1>
                </div>
            </header>

            <SessionHeader />

            <nav aria-label="Actor navigation" className="actor-nav">
                {actorNavigation.map((actor) => (
                    <NavLink key={actor.key} className={navClassName} to={actor.defaultPath}>
                        <span className="nav-pill__label">{actor.displayLabel}</span>
                    </NavLink>
                ))}
            </nav>

            <nav aria-label={`${activeActor.displayLabel} tasks`} className="task-nav">
                {activeActor.tasks.map((task) => (
                    <NavLink key={task.path} className={navClassName} to={task.path}>
                        <span className="nav-pill__label">{task.label}</span>
                    </NavLink>
                ))}
            </nav>

            <main className="page-stage">
                <Outlet />
            </main>
        </div>
    );
}
