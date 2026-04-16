import React from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import "./App.css";
import { SessionProvider } from "./context/SessionContext";
import { AuthorFlowProvider } from "./context/AuthorFlowContext";
import { AppShell } from "./components/Shell";
import { IssuerCreatePage, IssuerSelectiveDisclosurePage } from "./pages/IssuerPages";
import { CavsConfigPage, CavsIssuerTrustPage } from "./pages/CavsPages";
import {
    AuthorRequestPage,
    AuthorSelectiveDisclosurePage,
    AuthorStatementsPage,
} from "./pages/AuthorPages";
import { ReaderDecodeTracePage, ReaderHistoryPage } from "./pages/ReaderPages";

function App() {
    return (
        <SessionProvider>
            <AuthorFlowProvider>
                <BrowserRouter
                    future={{
                        v7_relativeSplatPath: true,
                        v7_startTransition: true,
                    }}
                >
                    <Routes>
                        <Route path="/" element={<AppShell />}>
                            <Route index element={<Navigate to="/issuer/create" replace />} />

                            <Route path="issuer">
                                <Route index element={<Navigate to="create" replace />} />
                                <Route path="create" element={<IssuerCreatePage />} />
                                <Route
                                    path="selective-disclosure"
                                    element={<IssuerSelectiveDisclosurePage />}
                                />
                            </Route>

                            <Route path="cavs">
                                <Route index element={<Navigate to="config" replace />} />
                                <Route path="config" element={<CavsConfigPage />} />
                                <Route path="issuer-trust" element={<CavsIssuerTrustPage />} />
                            </Route>

                            <Route path="author">
                                <Route index element={<Navigate to="request" replace />} />
                                <Route path="request" element={<AuthorRequestPage />} />
                                <Route
                                    path="selective-disclosure"
                                    element={<AuthorSelectiveDisclosurePage />}
                                />
                                <Route path="statements" element={<AuthorStatementsPage />} />
                            </Route>

                            <Route path="reader">
                                <Route index element={<Navigate to="decode-trace" replace />} />
                                <Route path="decode-trace" element={<ReaderDecodeTracePage />} />
                                <Route path="history" element={<ReaderHistoryPage />} />
                            </Route>

                            <Route path="*" element={<Navigate to="/issuer/create" replace />} />
                        </Route>
                    </Routes>
                </BrowserRouter>
            </AuthorFlowProvider>
        </SessionProvider>
    );
}

export default App;
