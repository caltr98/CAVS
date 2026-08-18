import React, { createContext, useContext, useState } from "react";

const AuthorFlowContext = createContext(null);

export const statementTypes = [
    "News",
    "Article",
    "Rumor",
    "Comment",
    "Opinion",
    "Leak",
    "Blog",
    "Post",
];

export function AuthorFlowProvider({ children }) {
    const [skillsCredentials, setSkillsCredentials] = useState([]);
    const [selectedCredentialIndexes, setSelectedCredentialIndexes] = useState([]);
    const [statementCredentials, setStatementCredentials] = useState([]);
    const [statementCids, setStatementCids] = useState({});
    const [authorMessage, setAuthorMessage] = useState("Ready to request.");

    function toggleCredentialIndex(index) {
        setSelectedCredentialIndexes((previousIndexes) =>
            previousIndexes.includes(index)
                ? previousIndexes.filter((value) => value !== index)
                : [...previousIndexes, index],
        );
    }

    function clearSelections() {
        setSelectedCredentialIndexes([]);
    }

    function setStatementCid(index, cid) {
        setStatementCids((previousCids) => ({
            ...previousCids,
            [index]: cid,
        }));
    }

    const value = {
        authorMessage,
        clearSelections,
        selectedCredentialIndexes,
        setAuthorMessage,
        setSkillsCredentials,
        setStatementCid,
        setStatementCredentials,
        skillsCredentials,
        statementCids,
        statementCredentials,
        toggleCredentialIndex,
    };

    return <AuthorFlowContext.Provider value={value}>{children}</AuthorFlowContext.Provider>;
}

export function useAuthorFlow() {
    const context = useContext(AuthorFlowContext);
    if (!context) {
        throw new Error("useAuthorFlow must be used inside AuthorFlowProvider");
    }
    return context;
}
